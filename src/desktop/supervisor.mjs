// Supervises the agent host utility process (plan ch. 04, R02). The capsule and tray never depend on the host being
// alive: if it crashes, pending requests fail with a clear message, the UI shows "restarting", and the host comes back
// with bounded backoff (it gives up after repeated crashes and says so). Only one host runs at a time; the storage
// lock enforces single ownership even if a stale process lingers.
import { utilityProcess } from "electron";
import { fileURLToPath } from "node:url";

const ENTRY = fileURLToPath(new URL("../runtime/host-process.mjs", import.meta.url));
const BACKOFF = [500, 1000, 2000, 5000, 10000];

/**
 * @param {{ dataDir: string, settings: () => object, platform: (op, args, ctx) => Promise<any>, onMessage: (m) => void, onState: (s) => void, log?: Function }} o
 */
export function createSupervisor(o) {
	const log = o.log ?? (() => {});
	let child;
	let state = "stopped"; // starting | ready | restarting | down | stopped
	let seq = 0;
	const pending = new Map(); // id -> { resolve, reject, timer }
	const platformCalls = new Map(); // id -> AbortController
	const crashes = [];
	let stopping = false;
	let readyWaiters = [];

	const setState = (s, detail) => {
		state = s;
		o.onState({ state: s, ...detail });
		if (s === "ready") {
			for (const w of readyWaiters) w.resolve();
			readyWaiters = [];
		}
	};

	function start() {
		setState(crashes.length ? "restarting" : "starting");
		child = utilityProcess.fork(ENTRY, [], { serviceName: "midnight engine", stdio: "pipe" });
		child.stdout?.on("data", (d) => log("[engine]", String(d).trim()));
		child.stderr?.on("data", (d) => log("[engine:err]", String(d).trim()));
		child.on("message", onMessage);
		child.on("exit", (code) => {
			const was = child;
			child = undefined;
			for (const [id, p] of pending) {
				clearTimeout(p.timer);
				p.reject(new Error("Midnight's engine stopped; it is restarting. Try again in a moment."));
				pending.delete(id);
			}
			for (const ac of platformCalls.values()) ac.abort();
			platformCalls.clear();
			if (stopping || !was) return setState("stopped");
			const now = Date.now();
			crashes.push(now);
			while (crashes.length && now - crashes[0] > 120000) crashes.shift();
			log(`engine exited with code ${code}; restart ${crashes.length}`);
			if (crashes.length > BACKOFF.length) return setState("down", { error: "The engine kept stopping. Restart it from the tray or check the logs." });
			setState("restarting");
			setTimeout(() => !stopping && start(), BACKOFF[crashes.length - 1]);
		});
		child.postMessage({ kind: "init", dataDir: o.dataDir, settings: o.settings() });
	}

	async function onMessage(m) {
		switch (m.kind) {
			case "ready":
				setState("ready", { version: m.version });
				o.onMessage(m);
				break;
			case "response": {
				const p = pending.get(m.id);
				if (!p) break;
				pending.delete(m.id);
				clearTimeout(p.timer);
				if (m.ok) p.resolve(m.result);
				else p.reject(new Error(m.error));
				break;
			}
			case "platform": {
				const ac = new AbortController();
				platformCalls.set(m.id, ac);
				try {
					const result = await o.platform(m.op, m.args ?? {}, { signal: ac.signal });
					child?.postMessage({ kind: "platform-response", id: m.id, ok: true, result });
				} catch (err) {
					child?.postMessage({ kind: "platform-response", id: m.id, ok: false, error: String(err?.message ?? err), code: err?.code, uncertain: err?.uncertain });
				} finally {
					platformCalls.delete(m.id);
				}
				break;
			}
			case "platform-cancel":
				platformCalls.get(m.id)?.abort();
				break;
			case "log":
				log("[engine]", m.text);
				break;
			default:
				o.onMessage(m);
		}
	}

	function send(kind, payload, timeoutMs) {
		if (!child || (state !== "ready" && kind !== "auth")) return Promise.reject(new Error(state === "down" ? "Midnight's engine is stopped." : "Midnight's engine is starting; try again in a moment."));
		const id = ++seq;
		return new Promise((resolve, reject) => {
			const timer = timeoutMs ? setTimeout(() => (pending.delete(id), reject(new Error("the engine did not answer in time"))), timeoutMs) : undefined;
			pending.set(id, { resolve, reject, timer });
			child.postMessage({ kind, id, ...payload });
		});
	}

	return {
		start,
		state: () => state,
		ready: () => (state === "ready" ? Promise.resolve() : new Promise((resolve, reject) => readyWaiters.push({ resolve, reject }))),
		request: (method, params, timeoutMs = 0) => send("request", { method, params }, timeoutMs),
		auth: (op, args = {}) => send("auth", { op, args }),
		settings: (settings) => child?.postMessage({ kind: "settings", settings }),
		signal: (signal) => child?.postMessage({ kind: "signal", signal }),
		restart() {
			crashes.length = 0;
			if (child) child.kill();
			else start();
		},
		async stop() {
			stopping = true;
			if (!child) return;
			const c = child;
			await new Promise((resolve) => {
				const t = setTimeout(() => (c.kill(), resolve()), 3000);
				c.once("exit", () => (clearTimeout(t), resolve()));
				c.postMessage({ kind: "shutdown" });
			});
		},
	};
}
