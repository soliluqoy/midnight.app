// Spike: Pi coding-agent SDK 1.0.1 with a faux model, persistent session, tool interception, agent_settled.
import { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import fs from "node:fs";
import path from "node:path";

const dir = path.resolve("sdk-data");
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const t0 = Date.now();
const rt = await ModelRuntime.create({ authPath: path.join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
const faux = fauxProvider({ provider: "faux", models: [{ id: "m1", input: ["text", "image"], reasoning: false }] });
rt.registerNativeProvider(faux.provider);
const model = rt.getModel("faux", "m1");
console.log("model", !!model, "auth", rt.hasConfiguredAuth("faux"), `${Date.now() - t0}ms`);

let calls = 0;
const probe = {
	name: "probe",
	label: "Probe",
	description: "probe",
	parameters: Type.Object({ x: Type.String() }),
	async execute(_id, p) {
		calls++;
		return { content: [{ type: "text", text: `probed ${p.x}` }], details: {} };
	},
};
const loader = {
	getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
	getSkills: () => ({ skills: [], diagnostics: [] }),
	getPrompts: () => ({ prompts: [], diagnostics: [] }),
	getThemes: () => ({ themes: [], diagnostics: [] }),
	getAgentsFiles: () => ({ agentsFiles: [] }),
	getSystemPrompt: () => "test",
	getSystemPromptSource: () => undefined,
	getAppendSystemPrompt: () => [],
	getAppendSystemPromptSources: () => [],
	extendResources: () => {},
	reload: async () => {},
};
faux.setResponses([
	fauxAssistantMessage([fauxToolCall("probe", { x: "a" })], { stopReason: "toolUse" }),
	fauxAssistantMessage([fauxText("all done")]),
]);
const sm = SessionManager.create(dir, path.join(dir, "sessions"));
const { session } = await createAgentSession({
	cwd: dir,
	model,
	modelRuntime: rt,
	resourceLoader: loader,
	tools: ["probe"],
	customTools: [probe],
	sessionManager: sm,
	settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
});
const seen = [];
session.subscribe((e) => seen.push(e.type));
await session.prompt("go");
console.log("events", [...new Set(seen)].join(","));
console.log("tool calls", calls, "settled", seen.includes("agent_settled"));
const file = sm.getSessionFile?.();
console.log("session file", file, file && fs.existsSync(file));
session.dispose();
// reopen
const sm2 = SessionManager.open(file, path.join(dir, "sessions"));
const ctx = sm2.buildSessionContext?.() ?? null;
console.log("reopened messages", ctx?.messages?.length);
