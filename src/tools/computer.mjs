import { spawn } from "node:child_process";
import { desktopCapturer, screen, shell } from "electron";
import { fileURLToPath } from "node:url";
import { COMPUTER } from "./schemas.mjs";

const HELPER = fileURLToPath(new URL("./input-helper.ps1", import.meta.url));
const MAX_W = 1568;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const BROWSERS = new Set(["chrome", "msedge", "firefox", "brave", "opera", "vivaldi", "arc", "librewolf", "waterfox", "zen", "chromium", "thorium"]);

// ---- the persistent PowerShell helper (input, windows, UI Automation) ----
let proc;
let waiting = [];
let buf = "";

function helper() {
	if (proc) return proc;
	proc = spawn("powershell.exe", ["-NoProfile", "-NoLogo", "-MTA", "-ExecutionPolicy", "Bypass", "-File", HELPER], {
		stdio: ["pipe", "pipe", "ignore"],
		windowsHide: true,
	});
	proc.stdout.setEncoding("utf8");
	proc.stdout.on("data", (d) => {
		buf += d;
		let i;
		while ((i = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, i).trim();
			buf = buf.slice(i + 1);
			waiting.shift()?.(line);
		}
	});
	proc.on("exit", () => {
		proc = undefined;
		buf = "";
		const w = waiting;
		waiting = [];
		for (const f of w) f("err: input helper exited");
	});
	return proc;
}

// The helper reads ASCII JSON; escape everything else so typed text survives any console code page.
const asciiJson = (o) => JSON.stringify(o).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** Run one helper op. Resolves with the parsed JSON payload (or null for a bare "ok"). */
function call(op, args = {}, timeout = 8000) {
	if (process.platform !== "win32") return Promise.reject(new Error("desktop control is only available on Windows for now"));
	return new Promise((resolve, reject) => {
		let settled = false;
		const t = setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(new Error(`${op} timed out (the target app may be busy)`));
			proc?.kill(); // a hung UI Automation call would block every later command
		}, timeout);
		waiting.push((line) => {
			if (settled) return;
			settled = true;
			clearTimeout(t);
			if (line.startsWith("err")) return reject(new Error(line.replace(/^err:\s*/, "")));
			const payload = line.slice(2).trim();
			try {
				resolve(payload ? JSON.parse(payload) : null);
			} catch {
				resolve(payload);
			}
		});
		helper().stdin.write(`${asciiJson({ op, ...args })}\n`);
	});
}

export function stopComputer() {
	proc?.kill();
}
/** Fencing: the helper accepts input only under the armed lease epoch (see windows/lease.mjs). */
export const armHelper = (epoch) => call("arm", { epoch }, 15000);
export const disarmHelper = () => (proc ? call("disarm", {}, 3000).catch(() => proc?.kill()) : Promise.resolve());

// What the latest element list said about each control, so the shell can describe a click before it happens.
const lastElements = new Map();
let lastElementsWindow;
export function inspectComputer({ action, id, key }) {
	if (action === "click_element" && id !== undefined) {
		const e = lastElements.get(id);
		return { label: e?.n ?? "", role: e?.t ?? "", window: lastElementsWindow?.title ?? "" };
	}
	if (action === "key") return { label: key ?? "", window: lastElementsWindow?.title ?? "", commitContext: /^(ctrl\+)?enter$/i.test(key ?? "") && [...lastElements.values()].some((e) => e.focus && /edit|document/i.test(e.t ?? "")) };
	return { window: lastElementsWindow?.title ?? "" };
}
export const warmHelper = () => call("ping", {}, 15000).catch(() => {});
export const foreground = () => call("foreground");
export const listWindows = () => call("windows", { skipPid: process.pid });
export const browserUrl = (hwnd) => call("url", { hwnd }, 6000);

// Which window the user was in when they summoned the capsule (and its URL, if it is a browser).
let lastFg;
export async function noteForeground() {
	try {
		const w = await foreground();
		if (!w || w.pid === process.pid || !w.title) return;
		lastFg = { ...w, at: Date.now() };
		if (BROWSERS.has(w.proc)) {
			const u = await browserUrl(w.hwnd).catch(() => null);
			if (lastFg.hwnd === w.hwnd && u?.url) lastFg.url = normalizeUrl(u.url);
		}
	} catch {}
}
export const lastForeground = () => lastFg;
export const normalizeUrl = (u) => (!u ? "" : /^[a-z][a-z0-9+.-]*:/i.test(u) ? u : `https://${u}`);

// ---- screen geometry and capture ----
function geometry() {
	const d = screen.getPrimaryDisplay();
	const pw = Math.round(d.size.width * d.scaleFactor);
	const ph = Math.round(d.size.height * d.scaleFactor);
	const iw = Math.min(MAX_W, pw);
	return { pw, ph, iw, ih: Math.round((ph * iw) / pw), scale: pw / iw, dip: d.scaleFactor };
}

// Screenshot of the primary display, captured directly at the size the model sees (no full-size resize step).
async function shot() {
	const g = geometry();
	const [src] = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: g.iw, height: g.ih } });
	let img = src.thumbnail;
	const s = img.getSize();
	if (s.width !== g.iw) img = img.resize({ width: g.iw, height: g.ih, quality: "good" });
	return { data: img.toJPEG(78).toString("base64"), iw: g.iw, ih: g.ih, scale: g.scale };
}

// Full-resolution crop of a region (screenshot px), enlarged for reading small text.
async function zoom(x, y, w, h) {
	const g = geometry();
	const [src] = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: g.pw, height: g.ph } });
	const rect = {
		x: Math.max(0, Math.round(x * g.scale)),
		y: Math.max(0, Math.round(y * g.scale)),
		width: Math.round(w * g.scale),
		height: Math.round(h * g.scale),
	};
	rect.width = Math.max(8, Math.min(rect.width, g.pw - rect.x));
	rect.height = Math.max(8, Math.min(rect.height, g.ph - rect.y));
	let img = src.thumbnail.crop(rect);
	const k = Math.min(2, 1200 / rect.width, 900 / rect.height);
	if (k > 1.05 || k < 0.95) img = img.resize({ width: Math.round(rect.width * k), height: Math.round(rect.height * k), quality: "best" });
	return { data: img.toPNG().toString("base64"), rect, k };
}

const Params = COMPUTER.parameters;


/** `state.enabled` gates every call; `state.lastScale` maps the newest screenshot's coordinates. */
export function computerTool(state) {
	let epoch; // lease epoch of the action being executed
	const icall = (op, args = {}, t) => call(op, { ...args, epoch }, t);
	let elWindow; // window of the latest elements list
	let target; // the window midnight is working in: keystrokes only ever go there

	async function resolveWindow(spec) {
		const wins = await listWindows();
		if (!spec) return wins.find((w) => !w.min) ?? wins[0];
		if (/^\d+$/.test(spec)) return wins.find((w) => String(w.hwnd) === spec) ?? { hwnd: Number(spec), title: "", proc: "" };
		const q = spec.toLowerCase();
		return wins.find((w) => w.title.toLowerCase().includes(q)) ?? wins.find((w) => w.proc.includes(q));
	}

	// Before typing or pressing keys: make sure focus is in the target window (same app counts, e.g. its dialogs),
	// and never in midnight's own capsule. Refocus once; refuse rather than type into the wrong place.
	async function ensureFocus() {
		const fg = await foreground().catch(() => null);
		const self = !fg || fg.pid === process.pid;
		if (!self && (!target || fg.pid === target.pid)) return fg;
		const want = target ?? (await resolveWindow());
		if (!want) throw new Error("There is no window to type into.");
		await icall("focus", { hwnd: want.hwnd }).catch(() => false);
		await sleep(120);
		const now = await foreground().catch(() => null);
		if (!now || now.pid === process.pid || (want.pid && now.pid !== want.pid)) {
			throw new Error(
				`Keyboard focus is on "${now?.title ?? "unknown"}", not "${want.title}". Nothing was typed. Click inside the target window or use focus_window, then retry.`,
			);
		}
		return now;
	}
	const retarget = async () => {
		const fg = await foreground().catch(() => null);
		if (fg && fg.pid !== process.pid) target = fg;
	};

	// Start an app and wait for its window, then focus it (Windows often opens new windows behind the active one).
	async function launchAndWait(spec) {
		const before = new Set((await listWindows()).map((w) => w.hwnd));
		await icall("launch", { target: spec });
		const base = spec.split(/[\\/]/).pop().replace(/\.exe$/i, "").toLowerCase();
		for (let i = 0; i < 24; i++) {
			await sleep(250);
			const fresh = (await listWindows()).filter((w) => !before.has(w.hwnd));
			const w = fresh.find((x) => x.proc.includes(base) || x.title.toLowerCase().includes(base)) ?? fresh[0];
			if (w) {
				await icall("focus", { hwnd: w.hwnd }).catch(() => false);
				target = w;
				return `Opened ${w.proc} · ${w.title} (window ${w.hwnd}) and focused it.`;
			}
		}
		return `Launched ${spec}, but no new window appeared within 6s (it may reuse an existing window; check \`windows\`).`;
	}

	const describeEl = (e, scale) => {
		const bits = [`[${e.id}] ${e.t}`, e.n ? `"${e.n}"` : "(unnamed)"];
		if (e.v !== undefined) bits.push(`= "${e.v}"`);
		if (e.on !== undefined) bits.push(e.on ? "(checked)" : "(unchecked)");
		if (e.focus) bits.push("(focused)");
		if (e.off) bits.push("(disabled)");
		bits.push(`@ ${Math.round(e.x / scale)},${Math.round(e.y / scale)}`);
		return bits.join(" ");
	};

	return {
		...COMPUTER,
		parameters: Params,
		executionMode: "sequential",
		async execute(_id, p, signal) {
			const denied = state.authorize ? state.authorize(p) : state.enabled ? undefined : "Computer use is off for this task. It needs an approved plan with usesComputer: true (and Settings must allow it).";
			if (denied) return { content: [{ type: "text", text: denied }], details: {} };
			epoch = p.epoch;
			const g = geometry();
			if (!state.lastScale || state.lastScale === 1) state.lastScale = g.scale;
			const px = (v) => Math.round((v ?? 0) * state.lastScale);
			const need = (...k) => {
				for (const f of k) if (p[f] === undefined) throw new Error(`${p.action} needs ${f}`);
			};
			const text = (t) => ({ content: [{ type: "text", text: t }], details: { action: p.action } });
			// Show the purple cursor where midnight is about to act (DIP coordinates of the primary display).
			const show = (physX, physY, extra = {}) => {
				state.onAct?.({ action: p.action, x: physX !== undefined ? physX / g.dip : undefined, y: physY !== undefined ? physY / g.dip : undefined, ...extra });
			};
			let wantShot = p.screenshot !== false;
			let after = 0;
			let note = "";

			switch (p.action) {
				case "screenshot":
					show();
					wantShot = true;
					break;
				case "windows": {
					const wins = await listWindows();
					const fg = await foreground().catch(() => null);
					const lines = wins.map(
						(w) => `${w.hwnd} · ${w.proc} · ${w.title}${w.min ? " (minimized)" : ""}${fg && fg.hwnd === w.hwnd ? " [foreground]" : ""}`,
					);
					return text(`Open windows, topmost first:\n${lines.join("\n") || "(none)"}`);
				}
				case "focus_window": {
					need("window");
					const w = await resolveWindow(p.window);
					if (!w) throw new Error(`no window matches "${p.window}"`);
					const ok = await icall("focus", { hwnd: w.hwnd });
					target = w;
					note = ok ? `Focused ${w.proc} · ${w.title}.` : `Tried to focus ${w.title}; Windows may have blocked it (click the window instead).`;
					after = 250;
					break;
				}
				case "elements": {
					let w = p.window ? await resolveWindow(p.window) : await foreground().catch(() => null);
					if (!w || w.pid === process.pid || !w.title) w = await resolveWindow();
					if (!w) throw new Error("no window to inspect");
					show(w.x + w.w / 2, w.y + 20, { action: "elements" });
					let r = await call("elements", { hwnd: w.hwnd, max: 220, ms: 2500, sx: 0, sy: 0, sw: g.pw, sh: g.ph }, 10000);
					if (r.items.length < 4 && BROWSERS.has(r.window.proc)) {
						await sleep(400); // browsers build their accessibility tree on first request
						r = await call("elements", { hwnd: w.hwnd, max: 220, ms: 2500, sx: 0, sy: 0, sw: g.pw, sh: g.ph }, 10000);
					}
					elWindow = r.window;
					target = r.window;
					lastElements.clear();
					for (const e of r.items) lastElements.set(e.id, e);
					lastElementsWindow = r.window;
					state.lastScale = g.scale;
					const head = `Window ${r.window.hwnd}: ${r.window.proc} · ${r.window.title}${r.cut ? " (list cut short; zoom or scroll for more)" : ""}`;
					const lines = r.items.map((e) => describeEl(e, g.scale));
					// No controls (custom-drawn apps, games, elevated windows): send the screenshot now instead of a round trip for it.
					if (!lines.length) {
						note = `${head}\n(no controls exposed; here is a screenshot: act by coordinates, zoom to read small text)`;
						wantShot = true;
						break;
					}
					if (p.screenshot !== true) return text(`${head}\n${lines.join("\n")}`);
					note = `${head}\n${lines.join("\n")}`;
					break;
				}
				case "read_text": {
					// exact text of a window (documents, editors, browser pages) or one element, no screenshot needed
					const w = p.id === undefined ? (p.window ? await resolveWindow(p.window) : target ?? (await resolveWindow())) : null;
					if (p.id === undefined && !w) throw new Error("no window to read");
					const t = await call("text", { hwnd: w?.hwnd ?? 0, id: p.id, max: 40000 }, 10000);
					const s = String(t ?? "");
					const head = w ? `Text of ${w.proc} · ${w.title}` : `Text of element ${p.id}`;
					return text(`${head} (${s.length} chars):\n\n${s.length > 30000 ? `${s.slice(0, 30000)}\n[truncated]` : s || "(empty; use screenshot/zoom)"}`);
				}
				case "click_element": {
					need("id");
					const r = await call("elrect", { id: p.id });
					show(r.x, r.y);
					await sleep(120);
					await icall("click", { x: r.x, y: r.y, count: 1, button: "left" });
					await retarget();
					after = 300;
					break;
				}
				case "set_value": {
					need("id", "text");
					const r = await call("elrect", { id: p.id });
					show(r.x, r.y);
					let how = "";
					if (!BROWSERS.has(elWindow?.proc)) how = await icall("setvalue", { id: p.id, text: p.text }).catch(() => "");
					if (how !== "set") {
						// browsers (and fields without a value pattern): click, select all, type like a person
						await icall("click", { x: r.x, y: r.y, count: 1, button: "left" });
						await sleep(80);
						await ensureFocus();
						await icall("key", { combo: "ctrl+a" });
						if (p.text) await icall("type", { text: p.text });
						else await icall("key", { combo: "delete" });
					}
					after = 150;
					break;
				}
				case "click":
				case "double_click":
				case "right_click":
					need("x", "y");
					show(px(p.x), px(p.y));
					await sleep(120);
					await icall("click", {
						x: px(p.x),
						y: px(p.y),
						count: p.action === "double_click" ? 2 : 1,
						button: p.action === "right_click" ? "right" : "left",
					});
					await retarget();
					after = 300;
					break;
				case "move":
					need("x", "y");
					show(px(p.x), px(p.y));
					await icall("move", { x: px(p.x), y: px(p.y) });
					after = 60;
					break;
				case "drag":
					need("x", "y", "x2", "y2");
					show(px(p.x), px(p.y), { x2: px(p.x2) / g.dip, y2: px(p.y2) / g.dip });
					await sleep(120);
					await icall("drag", { x: px(p.x), y: px(p.y), x2: px(p.x2), y2: px(p.y2) });
					after = 200;
					break;
				case "type": {
					need("text");
					const w = await ensureFocus();
					show();
					await icall("type", { text: p.text }, 30000);
					note = `Typed into ${w.proc} · ${w.title}.`;
					after = 100;
					break;
				}
				case "key": {
					need("key");
					if (!/^win(\+|$)/i.test(p.key)) await ensureFocus(); // win-key combos are global
					show();
					await icall("key", { combo: p.key });
					after = 250;
					break;
				}
				case "scroll":
					need("x", "y");
					show(px(p.x), px(p.y));
					await icall("scroll", { x: px(p.x), y: px(p.y), dy: Math.round(p.dy ?? 0), dx: Math.round(p.dx ?? 0) });
					after = 250;
					break;
				case "zoom": {
					need("x", "y", "w", "h");
					show(px(p.x + p.w / 2), px(p.y + p.h / 2));
					const z = await zoom(p.x, p.y, p.w, p.h);
					return {
						content: [
							{
								type: "text",
								text: `Zoomed region x=${p.x} y=${p.y} w=${p.w} h=${p.h} (screenshot px), shown ${z.k.toFixed(1)}x. For clicks keep using screenshot coordinates, not this image's.`,
							},
							{ type: "image", data: z.data, mimeType: "image/png" },
						],
						details: { action: "zoom" },
					};
				}
				case "launch":
					need("target");
					show();
					if (/^https?:\/\//i.test(p.target)) {
						await shell.openExternal(p.target);
						after = 1500;
						await sleep(after);
						after = 0;
						await retarget();
					} else {
						note = await launchAndWait(p.target);
						after = 300;
					}
					break;
				case "wait":
					await sleep(Math.min(10, p.seconds ?? 1) * 1000);
					wantShot = p.screenshot !== false;
					break;
			}
			if (signal?.aborted) throw new Error("aborted");
			if (after) await sleep(after);
			const fg = await foreground().catch(() => null);
			const where = fg ? ` Active window: ${fg.proc} · ${fg.title}.` : "";
			if (!wantShot) return text(`${note ? `${note}\n` : ""}Done: ${p.action}.${where}`);
			const s = await shot();
			state.lastScale = s.scale;
			return {
				content: [
					{ type: "text", text: `${note ? `${note}\n` : ""}Done: ${p.action}.${where} Screenshot is ${s.iw}x${s.ih}.` },
					{ type: "image", data: s.data, mimeType: "image/jpeg" },
				],
				details: { action: p.action, image: s.data },
			};
		},
	};
}
