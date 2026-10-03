// Spike: does an inline extension's tool_call handler gate direct AND nested (ctx.executeTool) calls?
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import path from "node:path";
import fs from "node:fs";

const dir = path.resolve("gate-data");
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const rt = await ModelRuntime.create({ authPath: path.join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
const faux = fauxProvider({ provider: "faux", models: [{ id: "m1" }] });
rt.registerNativeProvider(faux.provider);
const effects = [];
const seenByGate = [];
const send = {
	name: "send",
	label: "Send",
	description: "send",
	parameters: Type.Object({ to: Type.String() }),
	async execute(_id, p) {
		effects.push(p.to);
		return { content: [{ type: "text", text: `sent ${p.to}` }], details: {} };
	},
};
const wrapper = {
	name: "wrapper",
	label: "Wrapper",
	description: "calls send through executeTool",
	parameters: Type.Object({ to: Type.String() }),
	async execute(_id, p, signal, _u, ctx) {
		const r = await ctx.executeTool("send", { to: p.to }, { signal });
		return { content: [{ type: "text", text: `nested: ${JSON.stringify(r.content?.[0]?.text ?? r)}` }], details: {} };
	},
};
const loader = new DefaultResourceLoader({
	cwd: dir,
	agentDir: dir,
	noExtensions: true,
	noSkills: true,
	noPromptTemplates: true,
	noThemes: true,
	noContextFiles: true,
	systemPrompt: "test",
	extensionFactories: [
		(pi) => {
			pi.on("tool_call", async (event) => {
				seenByGate.push(`${event.toolName}:${JSON.stringify(event.input ?? event.args ?? {})}`);
				const to = (event.input ?? event.args ?? {}).to;
				if (event.toolName === "send" && to === "evil") return { block: true, reason: "policy: destination not granted" };
				return undefined;
			});
		},
	],
});
await loader.reload();
faux.setResponses([
	fauxAssistantMessage([fauxToolCall("send", { to: "evil" }), fauxToolCall("wrapper", { to: "evil" }), fauxToolCall("send", { to: "ok" })], { stopReason: "toolUse" }),
	fauxAssistantMessage([fauxText("done")]),
]);
const { session } = await createAgentSession({
	cwd: dir,
	agentDir: dir,
	model: rt.getModel("faux", "m1"),
	modelRuntime: rt,
	resourceLoader: loader,
	tools: ["send", "wrapper"],
	customTools: [send, wrapper],
	sessionManager: SessionManager.inMemory(dir),
	settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
});
await session.bindExtensions({});
const results = [];
session.subscribe((e) => {
	if (e.type === "tool_execution_end") results.push(`${e.toolName}${e.parentToolCallId ? "(nested)" : ""} err=${e.isError}`);
});
await session.prompt("go");
console.log("gate saw:", seenByGate.join(" | "));
console.log("results:", results.join(" | "));
console.log("effects:", effects.join(",") || "(none)");
session.dispose();
