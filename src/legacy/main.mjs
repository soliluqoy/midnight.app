import { app, BrowserWindow, clipboard, globalShortcut, ipcMain, Menu, nativeImage, screen, shell, Tray } from "electron";
import { fileURLToPath } from "node:url";
import { createHarness } from "./agent.mjs";
import { loadSettings } from "./settings.mjs";
import { noteForeground, stopComputer, warmHelper } from "./tools/computer.mjs";
import { createWeb } from "./tools/web.mjs";

// Capsule sizes in CSS px. The renderer gets them through `dims` (as CSS variables), so this is the one source.
// The window adds a transparent gutter for the shadow, and everything is scaled by the text-size zoom.
// `read` is the wide reading view; 0 means "as tall as the screen allows".
const SIZES = { idle: [264, 52], chat: [440, 150], mission: [440, 640], settings: [440, 640], read: [740, 0] };
const GUTTER = 32;
const MARGIN = 24; // capsule sits this far above the taskbar / from the screen edge

const dir = (p) => fileURLToPath(new URL(p, import.meta.url));

let capsule;
let overlay;
let browserWin; // hidden background browser; the agent's web engine
let web; // text-only search and parallel page reading
let harness;
let ready;
let tray;
let running = false;
let reloadAfterRun = false;
let hotkey = "";
let lastSize = "idle";
const settings = loadSettings();

const listeners = [];
const emit = (msg) => {
	if (msg.type === "auth_event" && msg.event.type === "auth_url") shell.openExternal(msg.event.url);
	if (msg.type === "start") setRunning(true);
	if (msg.type === "done" || msg.type === "error") setRunning(false);
	capsule?.webContents.send("agent", msg);
	for (const l of listeners) l(msg);
};

// CSS size of each capsule state at the current zoom, clamped so it always fits on the screen.
function dims() {
	const z = settings.get().textSize;
	const wa = screen.getPrimaryDisplay().workArea;
	const maxW = Math.floor((wa.width - MARGIN * 2) / z - GUTTER);
	const maxH = Math.floor((wa.height - MARGIN * 2) / z - GUTTER);
	const out = {};
	for (const [k, [w, h]] of Object.entries(SIZES)) {
		out[k] = [Math.min(w, maxW), h ? Math.min(h, maxH) : Math.min(1100, maxH)];
	}
	return out;
}

function place(state) {
	lastSize = state;
	const z = settings.get().textSize;
	const [cw, ch] = dims()[state];
	const wa = screen.getPrimaryDisplay().workArea;
	const left = settings.get().corner === "left";
	capsule.setBounds({
		x: Math.round(left ? wa.x + MARGIN - GUTTER * z : wa.x + wa.width - MARGIN - (cw + GUTTER) * z),
		y: Math.round(wa.y + wa.height - MARGIN - (ch + GUTTER) * z),
		width: Math.round((cw + GUTTER * 2) * z),
		height: Math.round((ch + GUTTER * 2) * z),
	});
}

function applyZoom() {
	capsule.webContents.setZoomFactor(settings.get().textSize);
}

// Esc takes over, but only while a mission is running so it never steals Esc from other apps.
function setRunning(on) {
	if (on === running) return;
	running = on;
	if (on) {
		globalShortcut.register("Escape", takeOver);
	} else {
		globalShortcut.unregister("Escape");
		overlay?.webContents.send("overlay", { type: "off" });
		if (reloadAfterRun) {
			reloadAfterRun = false;
			harness?.reload().then(pushCurrent);
		}
	}
}
function takeOver() {
	harness?.abort();
	if (harness) harness.state.enabled = false;
	capsule?.webContents.send("agent", { type: "takeover" });
	overlay?.webContents.send("overlay", { type: "off" });
}

function summon() {
	// Remember where the user was (window, and the URL if it's a browser) before the capsule takes focus.
	if (!capsule.isFocused()) noteForeground();
	capsule.showInactive();
	capsule.webContents.send("agent", { type: "summon" });
}

function openSettings() {
	capsule.showInactive();
	capsule.webContents.send("agent", { type: "open-settings" });
}

function pushCurrent() {
	const cur = harness.current();
	capsule?.webContents.send("agent", { type: "model", provider: cur.provider, model: cur.model });
}

// Register the summon hotkey; on failure keep the previous one. Returns an error string or "".
function setHotkey(acc) {
	if (acc === hotkey) return "";
	let ok = false;
	try {
		ok = globalShortcut.register(acc, summon);
	} catch {
		ok = false;
	}
	if (!ok) return "That shortcut is taken or not valid.";
	if (hotkey) globalShortcut.unregister(hotkey);
	hotkey = acc;
	return "";
}

function trayIcon() {
	const n = 16;
	const buf = Buffer.alloc(n * n * 4);
	for (let y = 0; y < n; y++) {
		for (let x = 0; x < n; x++) {
			const d = Math.hypot(x - 7.5, y - 7.5);
			const i = (y * n + x) * 4;
			if (d <= 6.5) [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]] = [0x80 - y * 2, 0x68 + y * 3, 0xe8, 255]; // BGRA
		}
	}
	return nativeImage.createFromBuffer(buf, { width: n, height: n });
}

async function createWindows() {
	const wa = screen.getPrimaryDisplay();

	capsule = new BrowserWindow({
		width: 1,
		height: 1,
		show: false, // shown once the core is loaded, so the pill is never visible-but-unresponsive
		frame: false,
		transparent: true,
		resizable: false,
		skipTaskbar: true,
		alwaysOnTop: true,
		hasShadow: false,
		title: "midnight.server",
		webPreferences: { preload: dir("./preload.cjs"), contextIsolation: true, backgroundThrottling: false },
	});
	place("idle");
	capsule.webContents.setVisualZoomLevelLimits(1, 1);
	capsule.webContents.on("did-finish-load", applyZoom);
	// Right-click Cut / Copy / Paste, so keys and prompts can be pasted with the mouse too.
	capsule.webContents.on("context-menu", (_e, p) => {
		const items = p.isEditable
			? [{ role: "cut", enabled: p.editFlags.canCut }, { role: "copy", enabled: p.editFlags.canCopy }, { role: "paste", enabled: p.editFlags.canPaste }, { type: "separator" }, { role: "selectAll" }]
			: p.selectionText
				? [{ role: "copy" }]
				: [];
		if (items.length) Menu.buildFromTemplate(items).popup({ window: capsule });
	});
	capsule.loadFile(dir("./ui/index.html"));

	// Full-screen, click-through layer: the purple cursor and dashed frame that show what midnight is doing.
	overlay = new BrowserWindow({
		x: wa.bounds.x,
		y: wa.bounds.y,
		width: wa.bounds.width,
		height: wa.bounds.height,
		frame: false,
		transparent: true,
		focusable: false,
		skipTaskbar: true,
		alwaysOnTop: true,
		hasShadow: false,
		show: false,
		// own partition: Chromium shares zoom per origin, and the capsule's text-size zoom must not scale the overlay
		webPreferences: { preload: dir("./preload.cjs"), contextIsolation: true, backgroundThrottling: false, partition: "midnight-overlay" },
	});
	overlay.setAlwaysOnTop(true, "screen-saver");
	overlay.setIgnoreMouseEvents(true);
	overlay.setContentProtection(true); // never appears in the agent's own screenshots
	overlay.loadFile(dir("./ui/overlay.html"));
	overlay.showInactive();

	// The web engine: an ordinary window the user never has to see.
	browserWin = new BrowserWindow({
		width: 1280,
		height: 800,
		show: false,
		title: "midnight.server browser",
		webPreferences: { partition: "persist:midnight-browser", backgroundThrottling: false },
	});
	browserWin.setMenuBarVisibility(false);
	browserWin.on("close", (e) => {
		if (!app.isQuitting) {
			e.preventDefault();
			browserWin.hide();
		}
	});
	browserWin.webContents.setWindowOpenHandler(({ url }) => {
		browserWin.webContents.loadURL(url);
		return { action: "deny" };
	});
	browserWin.loadURL("about:blank");

	const onAct = (a) => {
		if (!overlay || overlay.isDestroyed()) return;
		overlay.webContents.send("overlay", { type: "act", ...a });
	};
	web = createWeb(settings);
	web.warm();
	ready = createHarness({ getBrowserContents: () => browserWin.webContents, web, emit, hooks: { onAct }, settings }).then(
		(h) => (harness = h),
	);
	warmHelper(); // PowerShell + UI Automation take ~1s to start; overlap it with the core load, not the first summon
	await ready;
	capsule.showInactive();
}

// ---- IPC ----
const snapshot = () => ({ settings: settings.get(), current: harness.current() });

ipcMain.handle("init", async () => {
	await ready;
	return { ...snapshot(), hasModel: harness.hasSession() };
});
ipcMain.handle("size", (_e, state) => place(state));
ipcMain.handle("dims", () => dims());
ipcMain.handle("copy", (_e, text) => clipboard.writeText(String(text)));
ipcMain.handle("clipboard", () => clipboard.readText().slice(0, 30000));
ipcMain.handle("text-size", (_e, z) => {
	settings.set({ textSize: z });
	applyZoom();
	capsule.webContents.send("agent", { type: "relayout" });
	return settings.get().textSize;
});
ipcMain.handle("focus", () => capsule.focus());
ipcMain.handle("send", (_e, text) => harness.send(text));
ipcMain.handle("abort", () => takeOver());
ipcMain.handle("reset", () => harness.reset());
ipcMain.handle("decide", (_e, id, value) => harness.decide(id, value));
ipcMain.handle("peek", () => {
	if (browserWin.isVisible()) browserWin.hide();
	else browserWin.show();
	return browserWin.isVisible();
});

// settings
ipcMain.handle("settings:get", async () => ({
	...snapshot(),
	accounts: harness.accounts(),
	models: await harness.models(),
	version: app.getVersion(),
	dataDir: app.getPath("userData"),
}));
ipcMain.handle("settings:set", async (_e, patch) => {
	const before = settings.get();
	let error = "";
	if (patch.hotkey && patch.hotkey !== before.hotkey) {
		error = setHotkey(patch.hotkey);
		if (error) delete patch.hotkey;
	}
	settings.set(patch);
	const after = settings.get();
	if (after.corner !== before.corner) {
		capsule.webContents.send("agent", { type: "corner", corner: after.corner });
		place(lastSize);
	}
	if (after.launchAtLogin !== before.launchAtLogin && app.isPackaged && process.platform !== "linux") {
		app.setLoginItemSettings({ openAtLogin: after.launchAtLogin });
	}
	if (after.textSize !== before.textSize) {
		applyZoom();
		capsule.webContents.send("agent", { type: "relayout" });
	}
	capsule.webContents.send("agent", { type: "settings", settings: after });
	const reloadKeys = ["provider", "model", "thinking", "answerLength", "instructions"];
	if (reloadKeys.some((k) => after[k] !== before[k])) {
		if (running) reloadAfterRun = true;
		else {
			try {
				await harness.reload();
				pushCurrent();
			} catch (err) {
				error = `Couldn't switch model: ${err?.message ?? err}`;
			}
		}
	}
	return { settings: after, current: harness.current(), error };
});
ipcMain.handle("settings:login", async (_e, providerId, type, key) => {
	try {
		await harness.login(providerId, type, typeof key === "string" && key.trim() ? key.trim() : undefined);
		await harness.reload();
		pushCurrent();
		return { ok: true, current: harness.current() };
	} catch (err) {
		return { ok: false, error: String(err?.message ?? err) };
	}
});
ipcMain.handle("settings:cancel-login", () => harness.cancelLogin());
ipcMain.handle("settings:logout", async (_e, providerId) => {
	await harness.logout(providerId);
	await harness.reload();
	pushCurrent();
});
ipcMain.handle("settings:clear-browser", async () => {
	await browserWin.webContents.session.clearStorageData();
	await browserWin.webContents.session.clearCache();
	await web.clear();
});
ipcMain.handle("settings:open-data", () => shell.openPath(app.getPath("userData")));
ipcMain.handle("open-external", (_e, url) => (/^https?:\/\//.test(url) ? shell.openExternal(url) : undefined));

app.whenReady().then(async () => {
	app.setAppUserModelId("midnight.app"); // lets "done" notifications show while the capsule is tucked away
	if (process.platform === "darwin") app.dock?.hide(); // a capsule, not a Dock app
	await createWindows();

	// Headless check: MIDNIGHT_SELFTEST="prompt" runs one prompt with plans/asks auto-approved, prints events, exits.
	if (process.env.MIDNIGHT_SELFTEST) {
		listeners.push((m) => {
			if (m.type === "text") process.stdout.write(m.delta);
			else if (m.type === "plan") {
				console.log(`\n[plan] ${JSON.stringify(m.steps.map((s) => s.title))} computer=${m.usesComputer}`);
				harness.decide(m.id, true);
			} else if (m.type === "ask") {
				console.log(`\n[ask] ${m.title} — ${m.detail ?? ""}`);
				harness.decide(m.id, process.env.MIDNIGHT_SELFTEST_ASK !== "no");
			} else if (m.type === "progress") console.log(`[progress] ${m.step} ${m.status}`);
			else if (m.type === "tool_start") console.log(`\n[tool ${((Date.now() - t0) / 1000).toFixed(1)}s] ${m.name} ${JSON.stringify(m.args)}`);
			else if (m.type === "tool_end") console.log(`[tool done ${((Date.now() - t0) / 1000).toFixed(1)}s] err=${m.isError}${m.urls ? ` urls=${m.urls.length}` : ""}`);
			else if (m.type === "error") console.log(`\n[error] ${m.message}`);
		});
		console.log(`[model] ${JSON.stringify(harness.current())}`);
		await noteForeground(); // selftest: the terminal window counts as "where the user was"
		const t0 = Date.now();
		await harness.send(process.env.MIDNIGHT_SELFTEST);
		console.log(`\n[selftest done ${((Date.now() - t0) / 1000).toFixed(1)}s]`);
		app.exit(0);
		return;
	}

	if (setHotkey(settings.get().hotkey)) setHotkey("CommandOrControl+Alt+M");
	tray = new Tray(trayIcon());
	tray.setToolTip("midnight.server");
	tray.on("click", summon);
	tray.setContextMenu(
		Menu.buildFromTemplate([
			{ label: "Ask midnight.server", click: summon },
			{ label: "Settings…", click: openSettings },
			{ label: "Show background browser", click: () => browserWin.show() },
			{ type: "separator" },
			{ label: "Quit", click: () => app.quit() },
		]),
	);
	capsule.webContents.on("did-finish-load", () => capsule.webContents.send("agent", { type: "corner", corner: settings.get().corner }));
	screen.on("display-metrics-changed", () => capsule.webContents.send("agent", { type: "relayout" }));
});

app.on("before-quit", () => {
	app.isQuitting = true;
});
app.on("will-quit", () => {
	globalShortcut.unregisterAll();
	stopComputer();
	web?.dispose();
});
app.on("window-all-closed", () => app.quit());
