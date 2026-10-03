// The shell's side of the host boundary: a fixed table of operations the agent host may ask for. Nothing here decides
// authority (the host's broker did); desktop input is additionally refused unless it carries the live lease epoch.
import fs from "node:fs";
import path from "node:path";
import { safeStorage, shell } from "electron";
import { COMPUTER_OBSERVE } from "../tools/schemas.mjs";
import { computerTool, inspectComputer } from "../tools/computer.mjs";
import { userBrowserTool } from "../tools/userbrowser.mjs";

/**
 * @param {{ web: object, browsers: object, lease: object, onAct: Function, allowedOpen: (p: string) => boolean, overlay: (m) => void }} d
 */
export function createPlatform(d) {
	const { web, browsers, lease } = d;
	const userBrowser = userBrowserTool(web);
	const computerState = {
		lastScale: 1,
		onAct: d.onAct,
		authorize(p) {
			if (process.platform !== "win32") return "Desktop control is only available on Windows for now.";
			if (COMPUTER_OBSERVE.has(p.action)) return undefined;
			if (!lease.valid(p.missionId, p.epoch)) return "Midnight does not hold the screen (the user took over or the lease expired). Nothing was typed or clicked.";
			return undefined;
		},
	};
	const computer = computerTool(computerState);
	const toolByName = (name) => web.tools.find((t) => t.name === name);

	const ops = {
		"tool.search": (a, c) => toolByName("search").execute("s", a, c.signal),
		"tool.read_pages": (a, c) => toolByName("read_pages").execute("r", a, c.signal),
		"tool.browser": (a, c) => {
			const { missionId, ...args } = a;
			return browsers.execute(missionId, args, c.signal);
		},
		"tool.user_browser": (a, c) => userBrowser.execute("u", a, c.signal),
		"tool.computer": async (a, c) => {
			const out = await computer.execute("c", a, c.signal);
			if (!COMPUTER_OBSERVE.has(a.action)) lease.heartbeat(a.missionId, a.epoch);
			// screenshots go back as content; drop the duplicate copy in details
			return { content: out.content, details: { action: a.action } };
		},
		"inspect.browser": (a) => browsers.inspect(a.missionId, a),
		"inspect.computer": (a) => inspectComputer(a),
		"lease.acquire": (a) => lease.acquire(a.missionId, { background: !!a.background, title: a.title }),
		"lease.release": (a) => lease.release(a.missionId, a.epoch),
		"lease.revokeAll": () => lease.revokeAll("stop"),
		"fetch.page": async (a, c) => {
			if (!/^https?:\/\//i.test(a.url ?? "")) throw new Error("only http(s) pages");
			const pg = await web.read(a.url, "", c.signal);
			return { title: pg.title, text: pg.text };
		},
		"open.path": async (a) => {
			const p = path.resolve(String(a.path ?? ""));
			if (!d.allowedOpen(p) || !fs.existsSync(p)) throw new Error("Midnight only opens its own drafts and files in your selected folders");
			if (a.reveal) shell.showItemInFolder(p);
			else {
				const err = await shell.openPath(p);
				if (err) throw new Error(err);
			}
			return { ok: true };
		},
		"vault.encrypt": (a) => (safeStorage.isEncryptionAvailable() ? { available: true, ciphertext: safeStorage.encryptString(String(a.text)).toString("base64") } : { available: false }),
		"vault.decrypt": (a) => (safeStorage.isEncryptionAvailable() ? { available: true, text: safeStorage.decryptString(Buffer.from(String(a.ciphertext), "base64")) } : { available: false }),
	};

	return async (op, args, ctx) => {
		const fn = Object.hasOwn(ops, op) ? ops[op] : undefined;
		if (!fn) throw new Error(`unknown platform operation ${op}`);
		return fn(args, ctx);
	};
}
