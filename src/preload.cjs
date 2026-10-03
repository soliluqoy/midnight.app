// The capsule's only bridge to the shell (plan ch. 04, R01): one named function per allowed method, a versioned
// envelope with a per-page sequence number, and no generic invoke. Must match src/contracts/ipc.mjs (a sandboxed
// preload cannot import it).
const { contextBridge, ipcRenderer } = require("electron");

const V = 1;
const CHANNEL = "midnight:v1";
const EVENTS = "midnight:ev";
let seq = 0;

async function call(method, params = {}) {
	const r = await ipcRenderer.invoke(CHANNEL, { v: V, seq: ++seq, method, params });
	if (!r?.ok) throw new Error(r?.error ?? "request failed");
	return r.result;
}
const m = (method) => (params) => call(method, params);

contextBridge.exposeInMainWorld("midnight", {
	ui: { size: (state) => call("ui.size", { state }), dims: m("ui.dims"), focus: m("ui.focus"), textSize: (z) => call("ui.textSize", { z }) },
	clipboard: { read: m("clipboard.read"), write: (text) => call("clipboard.write", { text }) },
	openExternal: (url) => call("open.external", { url }),
	peekBrowser: m("browser.peek"),
	settings: { get: m("settings.get"), set: (patch) => call("settings.set", { patch }) },
	auth: {
		login: (provider, type, key) => call("auth.login", key ? { provider, type, key } : { provider, type }),
		cancel: m("auth.cancel"),
		logout: (provider) => call("auth.logout", { provider }),
		answer: (promptId, value) => call("auth.answer", { promptId, value }),
	},
	missions: {
		create: m("mission.create"),
		followUp: m("mission.followUp"),
		steer: m("mission.steer"),
		pause: m("mission.pause"),
		resume: m("mission.resume"),
		cancel: m("mission.cancel"),
		archive: m("mission.archive"),
		confirm: m("mission.confirm"),
		answer: m("mission.answer"),
		extendBudget: m("mission.extendBudget"),
		resolveUnknown: m("mission.resolveUnknown"),
		checkAgain: m("mission.checkAgain"),
		saveRecipe: m("mission.saveRecipe"),
	},
	approvals: { displayed: m("approval.displayed"), decide: m("approval.decide") },
	stop: { emergency: m("stop.emergency"), clear: m("stop.clear") },
	proactive: { pause: (paused) => call("proactive.pause", { paused }) },
	grants: { create: (draft) => call("grant.create", { draft }), revoke: (grantId) => call("grant.revoke", { grantId }), list: m("grant.list") },
	watches: { create: (draft) => call("watch.create", { draft }), setPaused: m("watch.setPaused"), remove: (watchId) => call("watch.delete", { watchId }), list: m("watch.list") },
	notifications: { act: m("notification.act") },
	memory: { list: m("memory.list"), remember: m("memory.remember"), correct: m("memory.correct"), confirm: (memoryId) => call("memory.confirm", { memoryId }), forget: (memoryId) => call("memory.forget", { memoryId }), export: m("memory.export") },
	recipes: { list: m("recipe.list"), review: m("recipe.review"), run: m("recipe.run") },
	skills: { list: m("skill.list") },
	connectors: { list: m("connector.list") },
	sources: { pick: (purpose) => call("sources.pick", { purpose }), list: m("sources.list"), remove: (rootId) => call("sources.remove", { rootId }) },
	artifacts: { open: (artifactId, reveal) => call("artifact.open", reveal ? { artifactId, reveal: true } : { artifactId }) },
	query: { snapshot: m("query.snapshot"), events: (afterSeq) => call("query.events", { afterSeq }), mission: (missionId) => call("query.mission", { missionId }), history: m("query.history") },
	resources: { status: m("resources.status") },
	data: { clearBrowser: m("data.clearBrowser"), openFolder: m("data.openFolder"), export: m("data.export"), remove: (scope) => call("data.delete", { scope }), diagnostics: m("diagnostics.preview"), saveDiagnostics: m("diagnostics.save") },
	engine: { restart: m("engine.restart") },
	updates: { check: m("update.check"), install: m("update.install") },
	/** Shell and engine events: { kind: "update" | "live" | "ready" | "shell" | "auth-prompt" | "auth-event", ... } */
	on: (fn) => ipcRenderer.on(EVENTS, (_e, d) => fn(d)),
	onOverlay: (fn) => ipcRenderer.on("overlay", (_e, d) => fn(d)),
});
