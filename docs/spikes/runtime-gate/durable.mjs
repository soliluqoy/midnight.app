// Spike: Pi Durable 1.0.1 on node:sqlite. Modes: run (tool hangs, parent kills us), resume (reopen and inspect).
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, Harness, hook, ToolTask } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import fs from "node:fs";

const mode = process.argv[2];
const file = "durable.sqlite";
if (mode === "run") for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });

const faux = fauxProvider({ provider: "faux", models: [{ id: "m1" }] });
const models = createModels();
models.setProvider(faux.provider);
const send = defineTool({
	name: "send",
	description: "send (unsafe, external effect)",
	parameters: Type.Object({ to: Type.String() }),
	execute: async (args) => {
		fs.appendFileSync("effects.log", `send ${args.to} pid=${process.pid}\n`);
		console.log("TOOL_STARTED");
		if (mode === "run") await new Promise(() => {}); // hang: the parent kills us after commit
		return { content: [{ type: "text", text: "sent" }] };
	},
});
const blocked = [];
const Guard = defineExtension({
	name: "guard",
	tools: [send],
	hooks: [hook(ToolTask, { beforeTool: (call) => (call.arguments?.to === "evil" ? (blocked.push(call.name), { block: "policy: destination not granted" }) : undefined) })],
});
const registry = createRegistry();
registry.install(Guard);
faux.setResponses([
	fauxAssistantMessage([fauxToolCall("send", { to: "evil" }), fauxToolCall("send", { to: "ok" })], { stopReason: "toolUse" }),
	fauxAssistantMessage([fauxText("after tools")]),
	fauxAssistantMessage([fauxText("after resume")]),
]);
const t0 = Date.now();
const harness = await Harness.open(await openNodeSqliteStorage(file), { models, registry }, ctx);
const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "m1" } } });
console.log("open", `${Date.now() - t0}ms`);
if (mode === "run") {
	const sub = await root.submit({ type: "input", content: "send it", requestId: "req-1" }, ctx);
	console.log("submitted", sub.id);
	await sub.wait(ctx);
} else {
	const again = await root.submit({ type: "input", content: "send it", requestId: "req-1" }, ctx);
	console.log("dedup submission id", again.id);
	harness.resume();
	const settled = await again.wait(ctx);
	console.log("settled", settled.status, settled.reason ?? "");
	const view = await root.viewState(ctx);
	const entries = view.value?.entries ?? view.get?.()?.entries ?? [];
	for (const e of entries) {
		const d = JSON.stringify(e.data ?? e).slice(0, 160);
		console.log("entry", e.kind, d);
	}
	console.log("blocked by hook (this process)", blocked.length);
	console.log("effects", fs.existsSync("effects.log") ? fs.readFileSync("effects.log", "utf8").trim().split("\n").length : 0);
	await harness.close(ctx);
}
