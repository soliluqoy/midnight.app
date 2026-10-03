// Visual and interaction contract for the capsule (plan ch. 02, F02/U05). Renders every surface from fixture data,
// captures it, and compares against stored baselines so the look people like does not drift unnoticed.
//   npx electron scripts/visual.mjs            compare with test/visual/baseline
//   UPDATE=1 npx electron scripts/visual.mjs   (re)write baselines after an intended design change
//   VISUAL_ERRORS_ONLY=1 ...                   render every state and fail only on renderer errors (other machines' fonts)
import { app, BrowserWindow, ipcMain, nativeImage } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const baseDir = path.join(root, "test", "visual", "baseline");
const outDir = path.join(root, "test", "visual", "out");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STATES = [
	["idle", "1+1"],
	["chat", `__fixture.variant("done"); document.getElementById("l-idle").click()`],
	["mission-running", `__fixture.variant("running"); missionApi.openMission("m1")`],
	["mission-approval", `__fixture.variant("approval")`],
	["mission-question", `__fixture.variant("question")`],
	["mission-reconcile", `__fixture.variant("reconcile")`],
	["mission-done", `__fixture.variant("done")`],
	["mission-partial", `__fixture.variant("partial")`],
	["read", `__fixture.variant("done"); document.dispatchEvent(new KeyboardEvent("keydown", { key: "e", ctrlKey: true, bubbles: true }))`],
	["stack", `document.dispatchEvent(new KeyboardEvent("keydown", { key: "e", ctrlKey: true, bubbles: true })); setTimeout(() => document.getElementById("bStack").click(), 300)`],
	["settings", `document.getElementById("gearStack").click()`],
];

app.whenReady().then(async () => {
	fs.mkdirSync(outDir, { recursive: true });
	fs.mkdirSync(baseDir, { recursive: true });
	const win = new BrowserWindow({
		width: 1300,
		height: 1400,
		show: false,
		backgroundColor: "#0b0e1c",
		webPreferences: { preload: path.join(root, "test", "visual", "preload.cjs"), contextIsolation: true, sandbox: true, offscreen: true },
	});
	win.webContents.setFrameRate(30);
	let size = "idle";
	ipcMain.handle("fixture:size", (_e, s) => {
		size = s;
	});
	const errors = [];
	win.webContents.on("console-message", (e) => {
		const level = e.level ?? e.params?.level;
		if (level === "error" || level === 3) errors.push(e.message ?? e.params?.message);
	});
	await win.loadFile(path.join(root, "src", "ui", "index.html"));
	await sleep(1500);
	const results = [];
	for (const [name, script] of STATES) {
		await win.webContents.executeJavaScript(script).catch((err) => errors.push(`${name}: ${err.message}`));
		await sleep(1400);
		const box = await win.webContents.executeJavaScript("(() => { const r = document.getElementById('cap').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, vw: innerWidth }; })()");
		const full = await win.webContents.capturePage();
		const sc = full.getSize().width / box.vw; // capture pixels per CSS pixel
		const pad = 16;
		const shotW = Math.round(box.w + pad * 2);
		const shotH = Math.round(box.h + pad * 2);
		const img = full.crop({ x: Math.max(0, Math.round((box.x - pad) * sc)), y: Math.max(0, Math.round((box.y - pad) * sc)), width: Math.round(shotW * sc), height: Math.round(shotH * sc) }).resize({ width: shotW, height: shotH, quality: "best" });
		const file = `${name}.png`;
		fs.writeFileSync(path.join(outDir, file), img.toPNG());
		const basePath = path.join(baseDir, file);
		if (process.env.VISUAL_ERRORS_ONLY) {
			results.push({ name, status: "rendered", size });
			continue;
		}
		if (process.env.UPDATE || !fs.existsSync(basePath)) {
			fs.writeFileSync(basePath, img.toPNG());
			results.push({ name, status: "baseline written", size });
			continue;
		}
		const base = nativeImage.createFromPath(basePath);
		const a = base.toBitmap();
		const b = img.toBitmap();
		const sameSize = base.getSize().width === img.getSize().width && base.getSize().height === img.getSize().height;
		let diff = 0;
		if (sameSize) for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) > 24 || Math.abs(a[i + 1] - b[i + 1]) > 24 || Math.abs(a[i + 2] - b[i + 2]) > 24) diff++;
		const ratio = sameSize ? diff / (a.length / 4) : 1;
		results.push({ name, status: ratio <= 0.01 ? "ok" : "CHANGED", diff: `${(ratio * 100).toFixed(2)}%`, size });
	}
	for (const r of results) console.log(`[visual] ${r.name.padEnd(18)} ${r.status}${r.diff ? ` (${r.diff} pixels differ)` : ""} · ${r.size}`);
	for (const e of errors) console.log(`[visual] renderer error: ${e}`);
	const failed = errors.length || results.some((r) => r.status === "CHANGED");
	console.log(`[visual] ${failed ? "FAILED" : "passed"} · screenshots in test/visual/out`);
	app.exit(failed ? 1 : 0);
});
