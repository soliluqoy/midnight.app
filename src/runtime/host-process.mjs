// Entry point of the agent host when it runs in an Electron utility process (plan ch. 04, R02). If this process
// crashes the capsule and tray stay usable and the shell restarts it; recovery then reconciles whatever was in flight.
// The host reaches the desktop only through the shell's fixed set of platform operations.
import { createHost } from "./host.mjs";

const port = process.parentPort;
const pending = new Map(); // platform request id -> { resolve, reject }
let seq = 0;
let host;

const platform = {
	call(op, args = {}, { signal } = {}) {
		const id = ++seq;
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject });
			port.postMessage({ kind: "platform", id, op, args });
			signal?.addEventListener(
				"abort",
				() => {
					port.postMessage({ kind: "platform-cancel", id });
					pending.delete(id);
					reject(new Error("aborted"));
				},
				{ once: true },
			);
		});
	},
	lease: {
		async acquire(missionId, { signal } = {}) {
			const r = await platform.call("lease.acquire", { missionId }, { signal });
			return { epoch: r.epoch, release: () => platform.call("lease.release", { missionId, epoch: r.epoch }).catch(() => {}) };
		},
		release: (missionId) => platform.call("lease.release", { missionId }).catch(() => {}),
		revokeAll: () => platform.call("lease.revokeAll", {}).catch(() => {}),
	},
};

const log = (...a) => port.postMessage({ kind: "log", text: a.map((x) => (x instanceof Error ? x.stack : typeof x === "string" ? x : JSON.stringify(x))).join(" ") });

port.on("message", async ({ data: m }) => {
	try {
		switch (m.kind) {
			case "init":
				host = await createHost({ dataDir: m.dataDir, platform, settings: m.settings, log });
				host.subscribe((out) => port.postMessage(out));
				await host.start();
				port.postMessage({ kind: "ready", snapshot: host.snapshot(), version: host.version });
				break;
			case "request":
				try {
					const result = await host.handle(m.method, m.params);
					port.postMessage({ kind: "response", id: m.id, ok: true, result: result === undefined ? null : JSON.parse(JSON.stringify(result)) });
				} catch (err) {
					port.postMessage({ kind: "response", id: m.id, ok: false, error: String(err?.message ?? err) });
				}
				break;
			case "platform-response": {
				const p = pending.get(m.id);
				pending.delete(m.id);
				if (!p) break;
				if (m.ok) p.resolve(m.result);
				else p.reject(Object.assign(new Error(m.error), { code: m.code, uncertain: m.uncertain }));
				break;
			}
			case "settings":
				host?.setSettings(m.settings);
				break;
			case "signal":
				host?.signal(m.signal);
				if (m.signal.type === "lease-revoked") {
					const owner = m.signal.missionId;
					if (owner) await host?.handle("mission.pause", { missionId: owner }).catch(() => {});
				}
				break;
			case "auth":
				// Model sign-in runs here because the host owns the model runtime.
				try {
					const result = await auth(m.op, m.args);
					port.postMessage({ kind: "response", id: m.id, ok: true, result });
				} catch (err) {
					port.postMessage({ kind: "response", id: m.id, ok: false, error: String(err?.message ?? err) });
				}
				break;
			case "shutdown":
				await host?.close();
				port.postMessage({ kind: "closed" });
				process.exit(0);
		}
	} catch (err) {
		log("host error", err);
	}
});

// ---- model accounts (same flows as the 0.1 engine, now inside the host) ----
let loginAbort;
const promptWaiters = new Map();
async function auth(op, a) {
	const rt = host.modelRuntime;
	switch (op) {
		case "accounts":
			return rt
				.getProviders()
				.map((p) => {
					const st = rt.getProviderAuthStatus(p.id);
					return { id: p.id, name: p.name, oauth: !!p.auth?.oauth, apiKey: !!p.auth?.apiKey?.login, configured: !!st.configured, source: st.source, label: st.label };
				})
				.sort((x, y) => Number(y.configured) - Number(x.configured) || x.name.localeCompare(y.name));
		case "models":
			return (await rt.getAvailable()).map((m) => ({ provider: m.provider, providerName: rt.getProvider(m.provider)?.name ?? m.provider, id: m.id, name: m.name, vision: !!m.input?.includes("image"), reasoning: !!m.reasoning, local: m.provider === "local" }));
		case "current": {
			const { routeModel } = await import("./models.mjs");
			try {
				const r = await routeModel(rt, host.settings(), "cloud");
				return { provider: r.route.provider, model: r.route.model };
			} catch {
				return { provider: "", model: "" };
			}
		}
		case "login": {
			loginAbort = new AbortController();
			const signal = loginAbort.signal;
			let usedKey = false;
			const ui = {
				signal,
				notify: (ev) => port.postMessage({ kind: "auth-event", event: ev }),
				prompt: async (p) => {
					if (a.key && p.type === "secret" && !usedKey) {
						usedKey = true;
						return a.key;
					}
					const id = `p${++seq}`;
					port.postMessage({ kind: "auth-prompt", id, prompt: { kind: p.type, message: p.message, placeholder: p.placeholder, options: p.options } });
					const v = await new Promise((resolve) => {
						promptWaiters.set(id, resolve);
						signal.addEventListener("abort", () => resolve(null), { once: true });
					});
					if (v === null || v === undefined || v === false) throw new Error("Cancelled");
					return v;
				},
			};
			try {
				await rt.login(a.provider, a.type, ui);
			} finally {
				loginAbort = undefined;
			}
			return { ok: true };
		}
		case "answer":
			promptWaiters.get(a.promptId)?.(a.value);
			promptWaiters.delete(a.promptId);
			return { ok: true };
		case "cancel":
			loginAbort?.abort();
			return { ok: true };
		case "logout":
			await rt.logout(a.provider);
			return { ok: true };
		case "benchmark": {
			const { benchmarkLocal } = await import("./models.mjs");
			return benchmarkLocal(host.settings().local);
		}
	}
	throw new Error(`unknown auth op ${op}`);
}
