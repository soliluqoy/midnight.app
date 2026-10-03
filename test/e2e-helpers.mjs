// End-to-end fixtures: the real host and Pi SDK sessions, driven by pi-ai's scripted faux model and a fake shell.
import fs from "node:fs";
import path from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createHost } from "../src/runtime/host.mjs";
import { tempDir } from "./helpers.mjs";

export { fauxAssistantMessage, fauxText, fauxToolCall };

export async function makeModel() {
	const dir = tempDir("core");
	const rt = await ModelRuntime.create({ authPath: path.join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
	const faux = fauxProvider({ provider: "faux", models: [{ id: "m1", input: ["text", "image"], reasoning: false }] });
	rt.registerNativeProvider(faux.provider);
	await rt.setRuntimeApiKey("faux", "test-key");
	return { rt, faux, core: { agentDir: dir, authPath: path.join(dir, "auth.json"), modelsStorePath: path.join(dir, "ms.json"), modelsPath: path.join(dir, "models.json") } };
}

/** A fake Electron shell: web tools answer from a table; hang() makes the next call of an op never return. */
export function fakePlatform(pages = {}) {
	const hangs = new Set();
	const calls = [];
	const platform = {
		calls,
		hang: (op) => hangs.add(op),
		async call(op, args) {
			calls.push({ op, args });
			if (hangs.has(op)) {
				hangs.delete(op);
				return new Promise(() => {});
			}
			switch (op) {
				case "tool.search":
					return { content: [{ type: "text", text: `results for ${args.queries.join(", ")}:\n1. A page\n   https://a.test/page` }], details: { urls: ["https://a.test/page"] } };
				case "tool.read_pages": {
					const ps = args.urls.map((u) => ({ url: u, title: pages[u]?.title ?? "Page", excerpt: pages[u]?.text ?? "text" }));
					return { content: [{ type: "text", text: ps.map((p) => `${p.title}\n${p.url}\n${p.excerpt}`).join("\n---\n") }], details: { urls: args.urls, pages: ps } };
				}
				case "fetch.page":
					return { text: pages[args.url]?.text ?? "", title: pages[args.url]?.title ?? "" };
				case "open.path":
					return { ok: true };
				case "vault.encrypt":
					return { available: true, ciphertext: Buffer.from(args.text).toString("base64") };
				case "vault.decrypt":
					return { available: true, text: Buffer.from(args.ciphertext, "base64").toString() };
				default:
					return { content: [{ type: "text", text: `${op} ok` }] };
			}
		},
		lease: { acquire: async () => ({ epoch: 1, release() {} }), release: async () => {}, revokeAll: async () => {} },
	};
	return platform;
}

export async function startHost({ dataDir = tempDir("host"), model, platform = fakePlatform(), settings = {}, before } = {}) {
	const host = await createHost({ dataDir, platform, modelRuntime: model.rt, core: model.core, settings: { provider: "faux", model: "m1", ...settings } });
	await before?.(host);
	await host.start();
	return { host, dataDir, platform };
}

export async function until(fn, ms = 8000) {
	const t = Date.now();
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() - t > ms) throw new Error("timed out waiting");
		await new Promise((r) => setTimeout(r, 15));
	}
}

export const settled = (host, id) => until(() => ["succeeded", "partially-succeeded", "failed", "cancelled", "needs-reconciliation", "waiting-input"].includes(host.repo.get(id)?.status) && !host.runtime.isRunning(id) && host.repo.get(id));

/** Approve the newest pending approval exactly as the capsule would (display ack, nonce, intent hash). */
export async function approve(host, decision = "approve") {
	const a = await until(() => host.approvals.pending().at(-1));
	await host.handle("approval.displayed", { approvalId: a.id, nonce: a.nonce });
	return host.handle("approval.decide", { approvalId: a.id, nonce: a.nonce, intentHash: a.intentHash, decision });
}

/** The id of the last artifact a tool reported in the transcript, e.g. "(art_...)". */
export const lastArtifact = (ctx, type) => {
	const texts = ctx.messages.filter((m) => m.role === "toolResult").flatMap((m) => m.content.filter((c) => c.type === "text").map((c) => c.text));
	for (const t of texts.reverse()) {
		const re = type === "chart" ? /Chart [^(]+\((art_\w+)\)/ : type === "draft" ? /Draft [^(]+\((art_\w+)\)/ : type === "report" ? /Report [^(]+\((art_\w+)\)/ : /\((art_\w+)\)/;
		const m = re.exec(t);
		if (m) return m[1];
	}
	throw new Error(`no ${type} artifact in transcript`);
};

export function writeFile(p, data) {
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, data);
	return p;
}
