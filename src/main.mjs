import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, Notification, powerMonitor, screen, shell, Tray } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EVENT_CHANNEL } from "./contracts/ipc.mjs";
import { createBrowsers } from "./desktop/browsers.mjs";
import { createIpcRouter } from "./desktop/ipc.mjs";
import { createPlatform } from "./desktop/platform.mjs";
import { createSupervisor } from "./desktop/supervisor.mjs";
import { createUpdater } from "./desktop/updater.mjs";
import { hostSettings, loadSettings } from "./settings.mjs";
import { armHelper, disarmHelper, noteForeground, stopComputer } from "./tools/computer.mjs";
import { userContext } from "./tools/userbrowser.mjs";
import { createWeb } from "./tools/web.mjs";
import { createScreenLease } from "./windows/lease.mjs";

// Isolated profiles for QA and smoke tests (never needed in normal use).
if (process.env.MIDNIGHT_USER_DATA) app.setPath("userData", path.resolve(process.env.MIDNIGHT_USER_DATA));
const settings = loadSettings();

// Rollback path (plan ch. 19): the 0.1 engine stays available behind a flag until the mission engine is adopted.
if (process.env.MIDNIGHT_ENGINE === "legacy" || settings.get().engine === "legacy") {
	await import("./legacy/main.mjs");
} else {
	startMissionShell();
}

function startMissionShell() {
	// Capsule sizes in CSS px. The renderer gets them through `ui.dims` (as CSS variables), so this is the one source.
	// The window adds a transparent gutter for the shadow, and everything is scaled by the text-size zoom.
	const SIZES = { idle: [264, 52], chat: [440, 150], mission: [440, 640], settings: [440, 640], stack: [440, 640], read: [740, 0] };
	const GUTTER = 32;
	const MARGIN = 24;
	const dir = (p) => fileURLToPath(new URL(p, import.meta.url));
	const UI_URL = new URL("./ui/index.html", import.meta.url).href;
	const EXECUTABLE = /\.(exe|bat|cmd|com|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|msi|msp|lnk|scr|hta|jar|reg|cpl|pif|appref-ms)$/i;

	let capsule;
	let overlay;
	let tray;
	let web;
	let browsers;
	let lease;
	let supervisor;
	let router;
	let updater;
	let hotkey = "";
	let lastSize = "idle";
	let escHeld = false;
	const active = new Set(); // missions that are running (Esc only belongs to midnight while something runs)
	const logFile = path.join(app.getPath("userData"), "logs", "shell.log");
	const dataDir = path.join(app.getPath("userData"), "missions");

	const log = (...a) => {
		try {
			fs.mkdirSync(path.dirname(logFile), { recursive: true });
			const line = `${new Date().toISOString()} ${a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}\n`;
			fs.appendFileSync(logFile, line.replace(/(sk|rk|pk)-[A-Za-z0-9_-]{16,}/g, "[key]"));
		} catch {}
	};
	const toCapsule = (m) => capsule && !capsule.isDestroyed() && capsule.webContents.send(EVENT_CHANNEL, m);

	if (!app.requestSingleInstanceLock()) {
		app.quit();
		return;
	}
	app.on("second-instance", () => summon());

	// ---------- placement: active-monitor aware, persisted, validated against current displays ----------
	function display() {
		const all = screen.getAllDisplays();
		const want = settings.get().display;
		return all.find((d) => String(d.id) === want) ?? screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) ?? screen.getPrimaryDisplay();
	}
	function dims() {
		const z = settings.get().textSize;
		const wa = display().workArea;
		const maxW = Math.floor((wa.width - MARGIN * 2) / z - GUTTER);
		const maxH = Math.floor((wa.height - MARGIN * 2) / z - GUTTER);
		const out = {};
		for (const [k, [w, h]] of Object.entries(SIZES)) out[k] = [Math.min(w, maxW), h ? Math.min(h, maxH) : Math.min(1100, maxH)];
		return out;
	}
	function place(state) {
		lastSize = state;
		const z = settings.get().textSize;
		const [cw, ch] = dims()[state] ?? dims().mission;
		const wa = display().workArea;
		const left = settings.get().corner === "left";
		capsule.setBounds({
			x: Math.round(left ? wa.x + MARGIN - GUTTER * z : wa.x + wa.width - MARGIN - (cw + GUTTER) * z),
			y: Math.round(wa.y + wa.height - MARGIN - (ch + GUTTER) * z),
			width: Math.round((cw + GUTTER * 2) * z),
			height: Math.round((ch + GUTTER * 2) * z),
		});
	}
	const applyZoom = () => capsule.webContents.setZoomFactor(settings.get().textSize);

	// ---------- Esc takes over, but only while midnight is working, so it never steals Esc from other apps ----------
	function syncEsc() {
		const want = active.size > 0 || !!lease?.current();
		if (want === escHeld) return;
		escHeld = want;
		if (want) globalShortcut.register("Escape", takeOver);
		else globalShortcut.unregister("Escape");
	}
	async function takeOver() {
		const owner = lease.current()?.missionId;
		await lease.revokeAll("esc"); // stop acknowledgment happens here, in the shell, before anything else
		supervisor.signal({ type: "lease-revoked", missionId: owner });
		toCapsule({ kind: "shell", type: "takeover", missionId: owner });
		overlay?.webContents.send("overlay", { type: "off" });
	}
	async function emergencyStop() {
		await lease.revokeAll("emergency");
		overlay?.webContents.send("overlay", { type: "off" });
		const r = await supervisor.request("stop.emergency", {}, 5000).catch((err) => ({ error: err.message }));
		toCapsule({ kind: "shell", type: "emergency", ...r });
		rebuildTray(true);
		return r;
	}

	function summon() {
		if (!capsule) return;
		if (!capsule.isFocused()) noteForeground(); // where the user was, before the capsule takes focus
		capsule.showInactive();
		toCapsule({ kind: "shell", type: "summon" });
	}
	function openSettings() {
		capsule.showInactive();
		toCapsule({ kind: "shell", type: "open-settings" });
	}
	function setHotkey(acc) {
		if (acc === hotkey) return "";
		let ok = false;
		try {
			ok = globalShortcut.register(acc, summon);
		} catch {}
		if (!ok) return "That shortcut is taken or not valid.";
		if (hotkey) globalShortcut.unregister(hotkey);
		hotkey = acc;
		return "";
	}

	function trayIcon() {
		const n = 16;
		const buf = Buffer.alloc(n * n * 4);
		for (let y = 0; y < n; y++)
			for (let x = 0; x < n; x++) {
				const d = Math.hypot(x - 7.5, y - 7.5);
				const i = (y * n + x) * 4;
				if (d <= 6.5) [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]] = [0x80 - y * 2, 0x68 + y * 3, 0xe8, 255]; // BGRA
			}
		return nativeImage.createFromBuffer(buf, { width: n, height: n });
	}
	let proactivePaused = false;
	function rebuildTray(stopped = false) {
		if (!tray) return;
		tray.setContextMenu(
			Menu.buildFromTemplate([
				{ label: "Ask midnight", click: summon },
				{ label: "Settings…", click: openSettings },
				{ label: "Show background browser", click: () => browsers.peek() },
				{ type: "separator" },
				{
					label: "Pause proactive work",
					type: "checkbox",
					checked: proactivePaused,
					click: (item) => {
						proactivePaused = item.checked;
						supervisor.request("proactive.pause", { paused: proactivePaused }).catch(() => {});
					},
				},
				stopped
					? { label: "Resume after emergency stop", click: () => supervisor.request("stop.clear", {}).then(() => rebuildTray(false)).catch(() => {}) }
					: { label: "Emergency stop", click: emergencyStop },
				{ label: "Restart engine", click: () => supervisor.restart() },
				{
					label: "Check for updates…",
					click: async () => {
						const r = await updater.check({ force: true });
						toCapsule({ kind: "shell", type: "update", ...r });
						if (r.available) summon();
					},
				},
				{ type: "separator" },
				{ label: "Quit", click: () => app.quit() },
			]),
		);
	}

	async function createWindows() {
		capsule = new BrowserWindow({
			width: 1,
			height: 1,
			show: false,
			frame: false,
			transparent: true,
			resizable: false,
			skipTaskbar: true,
			alwaysOnTop: true,
			hasShadow: false,
			title: "midnight",
			// background throttling on: hidden decorative animation stops (plan ch. 09)
			webPreferences: { preload: dir("./preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: true, spellcheck: false },
		});
		place("idle");
		capsule.webContents.setVisualZoomLevelLimits(1, 1);
		capsule.webContents.on("did-finish-load", () => {
			applyZoom();
			toCapsule({ kind: "shell", type: "corner", corner: settings.get().corner });
		});
		capsule.webContents.on("did-start-loading", () => router?.reset(capsule.webContents.id));
		capsule.webContents.on("will-navigate", (e) => e.preventDefault()); // the capsule never leaves its page
		capsule.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
		capsule.webContents.on("render-process-gone", () => setTimeout(() => !capsule.isDestroyed() && capsule.reload(), 500));
		capsule.webContents.on("context-menu", (_e, p) => {
			const items = p.isEditable
				? [{ role: "cut", enabled: p.editFlags.canCut }, { role: "copy", enabled: p.editFlags.canCopy }, { role: "paste", enabled: p.editFlags.canPaste }, { type: "separator" }, { role: "selectAll" }]
				: p.selectionText
					? [{ role: "copy" }]
					: [];
			if (items.length) Menu.buildFromTemplate(items).popup({ window: capsule });
		});
		capsule.loadFile(dir("./ui/index.html"));

		// Click-through layer: the purple cursor and frame that show what midnight is doing on screen.
		const db = display().bounds;
		overlay = new BrowserWindow({
			...db,
			frame: false,
			transparent: true,
			focusable: false,
			skipTaskbar: true,
			alwaysOnTop: true,
			hasShadow: false,
			show: false,
			webPreferences: { preload: dir("./preload.cjs"), contextIsolation: true, sandbox: true, backgroundThrottling: true, partition: "midnight-overlay" },
		});
		overlay.setAlwaysOnTop(true, "screen-saver");
		overlay.setIgnoreMouseEvents(true);
		overlay.setContentProtection(true); // never appears in the agent's own screenshots
		overlay.webContents.on("will-navigate", (e) => e.preventDefault());
		overlay.loadFile(dir("./ui/overlay.html"));
		overlay.showInactive();
	}

	function onAct(a) {
		if (overlay && !overlay.isDestroyed()) overlay.webContents.send("overlay", { type: "act", ...a });
	}

	function allowedOpen(p) {
		if (EXECUTABLE.test(p)) return false;
		return true; // the host only sends artifact paths it staged or published inside selected folders
	}

	// ---------- engine ----------
	let engineHook; // the headless self-test listens here
	function onEngineMessage(m) {
		engineHook?.(m);
		if (m.kind === "update") {
			const s = m.mission?.status;
			if (m.missionId) {
				if (["running", "verifying", "planning", "recovering"].includes(s)) active.add(m.missionId);
				else active.delete(m.missionId);
				if (["succeeded", "partially-succeeded", "failed", "cancelled"].includes(s)) browsers?.close(m.missionId);
				syncEsc();
			}
			if (m.type === "notification.created" && m.notifications) {
				const n = m.notifications.at?.(0);
				if (n && n.status === "queued" && !capsule.isFocused() && Notification.isSupported()) {
					const toast = new Notification({ title: `midnight · ${n.title}`, body: String(n.reason ?? "").slice(0, 180), silent: true });
					toast.on("click", () => (summon(), toCapsule({ kind: "shell", type: "open-mission", missionId: n.missionId })));
					toast.show();
				}
			}
		}
		if (m.kind === "auth-event" && m.event?.type === "auth_url" && /^https:\/\//.test(m.event.url)) shell.openExternal(m.event.url);
		toCapsule(m);
	}

	async function hostCall(method, params) {
		if ((method === "mission.create" || method === "mission.followUp") && settings.get().shareContext) {
			params = { ...params, context: await Promise.race([userContext().catch(() => ""), new Promise((r) => setTimeout(() => r(""), 800))]) };
		}
		return supervisor.request(method, params);
	}

	// ---------- shell-local IPC methods ----------
	const shellMethods = {
		"ui.size": ({ state }) => place(state),
		"ui.dims": () => dims(),
		"ui.focus": () => capsule.focus(),
		"ui.textSize": ({ z }) => {
			settings.set({ textSize: z });
			applyZoom();
			toCapsule({ kind: "shell", type: "relayout" });
			return settings.get().textSize;
		},
		"clipboard.read": () => clipboard.readText().slice(0, 30000),
		"clipboard.write": ({ text }) => clipboard.writeText(text),
		"open.external": ({ url }) => (/^https?:\/\//i.test(url) ? shell.openExternal(url) : undefined),
		"browser.peek": () => browsers.peek(),
		"settings.get": async () => {
			const [accounts, models, current] = await Promise.all([supervisor.auth("accounts").catch(() => []), supervisor.auth("models").catch(() => []), supervisor.auth("current").catch(() => ({ provider: "", model: "" }))]);
			return { settings: settings.get(), accounts, models, current, version: app.getVersion(), dataDir: app.getPath("userData"), engine: supervisor.state() };
		},
		"settings.set": async ({ patch }) => {
			const before = settings.get();
			let error = "";
			if (typeof patch.hotkey === "string" && patch.hotkey !== before.hotkey) {
				error = setHotkey(patch.hotkey);
				if (error) delete patch.hotkey;
			}
			const after = settings.set(patch);
			if (after.corner !== before.corner || after.display !== before.display) {
				toCapsule({ kind: "shell", type: "corner", corner: after.corner });
				place(lastSize);
			}
			if (after.launchAtLogin !== before.launchAtLogin && app.isPackaged && process.platform !== "linux") app.setLoginItemSettings({ openAtLogin: after.launchAtLogin });
			if (after.textSize !== before.textSize) {
				applyZoom();
				toCapsule({ kind: "shell", type: "relayout" });
			}
			supervisor.settings(hostSettings(after));
			if (after.engine !== before.engine) error = error || "Restart midnight to switch engines.";
			toCapsule({ kind: "shell", type: "settings", settings: after });
			const current = await supervisor.auth("current").catch(() => ({ provider: "", model: "" }));
			toCapsule({ kind: "shell", type: "model", ...current });
			return { settings: after, current, error };
		},
		"auth.login": async ({ provider, type, key }) => {
			try {
				await supervisor.auth("login", { provider, type, key: key?.trim() || undefined });
				const current = await supervisor.auth("current");
				toCapsule({ kind: "shell", type: "model", ...current });
				return { ok: true, current };
			} catch (err) {
				return { ok: false, error: String(err?.message ?? err) };
			}
		},
		"auth.cancel": () => supervisor.auth("cancel"),
		"auth.logout": async ({ provider }) => {
			await supervisor.auth("logout", { provider });
			toCapsule({ kind: "shell", type: "model", ...(await supervisor.auth("current")) });
		},
		"auth.answer": ({ promptId, value }) => supervisor.auth("answer", { promptId, value }),
		"data.clearBrowser": async () => {
			await browsers.clear();
			await web.clear();
		},
		"data.openFolder": () => shell.openPath(app.getPath("userData")),
		// The only way a folder becomes readable: the user picks it in the OS dialog.
		"sources.pick": async ({ purpose }) => {
			const r = await dialog.showOpenDialog(capsule, { title: purpose === "output" ? "Choose a folder midnight may save drafts to" : "Choose a folder midnight may read", properties: ["openDirectory"] });
			if (r.canceled || !r.filePaths[0]) return { canceled: true };
			return supervisor.request("sources.add", { path: r.filePaths[0], purpose });
		},
		"diagnostics.save": async () => {
			const { preview } = await supervisor.request("diagnostics.preview", {});
			const r = await dialog.showSaveDialog(capsule, { title: "Save support bundle", defaultPath: path.join(app.getPath("downloads"), `midnight-support-${Date.now()}.json`) });
			if (r.canceled || !r.filePath) return { canceled: true };
			let shellLog = "";
			try {
				shellLog = fs.readFileSync(logFile, "utf8").split("\n").slice(-300).join("\n");
			} catch {}
			fs.writeFileSync(r.filePath, JSON.stringify({ ...preview, shellLog }, null, 2));
			return { file: r.filePath };
		},
		"engine.restart": () => supervisor.restart(),
		"update.check": () => updater.check({ force: true }),
		"update.install": () => updater.install(),
	};

	app.whenReady().then(async () => {
		app.setAppUserModelId("midnight.app"); // lets notifications show while the capsule is tucked away
		if (process.platform === "darwin") app.dock?.hide();
		web = createWeb(settings); // windows are created lazily on first use (plan ch. 09: no eager warmup)
		browsers = createBrowsers();
		lease = createScreenLease({
			userIdleMs: () => powerMonitor.getSystemIdleTime() * 1000,
			arm: (epoch) => (process.platform === "win32" ? armHelper(epoch) : Promise.resolve()),
			disarm: () => disarmHelper(),
			onChange: (holder) => {
				toCapsule({ kind: "shell", type: "screen", holder });
				if (!holder) overlay?.webContents.send("overlay", { type: "off" });
				syncEsc();
			},
		});
		await createWindows();
		router = createIpcRouter({
			ipcMain,
			isTrusted: (event) => event.sender === capsule?.webContents && (event.senderFrame?.url ?? "").split("#")[0] === UI_URL,
			shell: shellMethods,
			host: hostCall,
			log,
		});
		supervisor = createSupervisor({
			dataDir,
			settings: () => hostSettings(settings.get()),
			platform: createPlatform({ web, browsers, lease, onAct, allowedOpen }),
			onMessage: onEngineMessage,
			onState: (s) => {
				log("engine", s.state, s.error ?? "");
				toCapsule({ kind: "shell", type: "engine", ...s });
			},
			log,
		});
		supervisor.start();
		updater = createUpdater({
			version: app.getVersion(),
			isBusy: async () => active.size > 0 || !!lease.current(),
			backup: () => supervisor.request("data.backup", {}),
			launch: (file) => {
				shell.openPath(file);
				setTimeout(() => app.quit(), 1500); // the installer replaces the app once it has quit
			},
			openPage: (url) => url && shell.openExternal(url),
		});
		if (settings.get().updates === "notify" && app.isPackaged) setTimeout(() => updater.check().then((r) => r.available && toCapsule({ kind: "shell", type: "update", ...r })), 60000);
		capsule.showInactive();

		// Power, lock and session signals: stop starting actions, give the screen back, catch up after waking.
		for (const ev of ["suspend", "resume", "on-ac", "on-battery", "lock-screen", "unlock-screen"]) {
			powerMonitor.on(ev, async () => {
				if (ev === "suspend" || ev === "lock-screen") await lease.revokeAll(ev);
				supervisor.signal({ type: ev });
			});
		}
		if (powerMonitor.isOnBatteryPower?.()) supervisor.signal({ type: "on-battery" });

		if (setHotkey(settings.get().hotkey)) setHotkey("CommandOrControl+Alt+M");
		tray = new Tray(trayIcon());
		tray.setToolTip("midnight");
		tray.on("click", summon);
		rebuildTray();
		screen.on("display-metrics-changed", () => toCapsule({ kind: "shell", type: "relayout" }));
		screen.on("display-removed", () => {
			if (!screen.getAllDisplays().some((d) => String(d.id) === settings.get().display)) settings.set({ display: "" });
			place(lastSize); // never leave the capsule on a monitor that is gone
		});

		if (process.env.MIDNIGHT_SELFTEST) selftest(process.env.MIDNIGHT_SELFTEST);
		if (process.env.MIDNIGHT_SMOKE) smoke();
		if (process.env.MIDNIGHT_PERF) perf(Number(process.env.MIDNIGHT_PERF) || 60);
	});

	// Idle trace (plan ch. 09): every Midnight process, sampled; whole-app CPU normalized to all cores; no model calls.
	async function perf(seconds) {
		await supervisor.ready();
		const t0 = Date.now();
		await new Promise((r) => setTimeout(r, 5000)); // past startup
		const cpu = [];
		const mem = [];
		const types = {};
		while (Date.now() - t0 < seconds * 1000 + 5000) {
			const ms = app.getAppMetrics();
			cpu.push(ms.reduce((a, m) => a + (m.cpu?.percentCPUUsage ?? 0), 0));
			mem.push(ms.reduce((a, m) => a + (m.memory?.privateBytes ?? m.memory?.workingSetSize ?? 0), 0) / 1024);
			for (const m of ms) types[m.type] = Math.round((m.memory?.privateBytes ?? m.memory?.workingSetSize ?? 0) / 1024);
			await new Promise((r) => setTimeout(r, 2000));
		}
		const pct = (arr, p) => [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))];
		const snap = await supervisor.request("resources.status", {});
		const cores = (await import("node:os")).cpus().length;
		console.log(
			`[perf] ${seconds}s idle · ${cores} cores · CPU median ${pct(cpu, 0.5).toFixed(2)}% p95 ${pct(cpu, 0.95).toFixed(2)}% (of one core; machine-normalized median ${(pct(cpu, 0.5) / cores).toFixed(3)}%) · private memory median ${pct(mem, 0.5).toFixed(0)} MB p95 ${pct(mem, 0.95).toFixed(0)} MB · by type ${JSON.stringify(types)} MB · queue ${JSON.stringify(snap.queue)}`,
		);
		await supervisor.stop();
		app.exit(0);
	}

	// Smoke check: the shell starts, the engine comes up in its own process, the capsule renders without errors.
	async function smoke() {
		const errors = [];
		capsule.webContents.on("console-message", (e) => {
			const level = e.level ?? e.params?.level;
			if (level === "error" || level === 3) errors.push(e.message ?? e.params?.message);
		});
		const t0 = Date.now();
		const timeout = setTimeout(() => {
			console.log(`[smoke] engine not ready after 30s (state ${supervisor.state()})`);
			app.exit(2);
		}, 30000);
		await supervisor.ready();
		const ms = Date.now() - t0;
		const snap = await supervisor.request("query.snapshot", {});
		const res = await supervisor.request("resources.status", {});
		await new Promise((r) => setTimeout(r, 2500)); // let the renderer finish its first paint and requests
		const ui = await capsule.webContents.executeJavaScript("({ state: document.getElementById('cap').dataset.s, status: document.getElementById('idleSt').textContent })").catch((err) => ({ error: String(err) }));
		clearTimeout(timeout);
		console.log(`[smoke] engine ready in ${ms} ms · seq ${snap.seq} · missions ${Object.keys(snap.missions).length} · weather "${res.weather?.text}" · ui ${JSON.stringify(ui)} · renderer errors ${errors.length}`);
		for (const e of errors) console.log(`[smoke] renderer error: ${e}`);
		await supervisor.stop();
		app.exit(errors.length ? 1 : 0);
	}

	// Headless check: MIDNIGHT_SELFTEST="prompt" runs one mission, approves what it asks (as the UI would), prints, exits.
	async function selftest(prompt) {
		await supervisor.ready();
		const t0 = Date.now();
		const seen = new Set();
		const done = new Promise((resolve) => {
			engineHook = (m) => {
				if (m.kind === "live" && m.type === "text") process.stdout.write(m.delta);
				if (m.kind !== "update" || !m.mission) return;
				for (const a of m.mission.approvals ?? []) {
					if (seen.has(a.id)) continue;
					seen.add(a.id);
					console.log(`\n[approval] ${a.display?.title}`);
					supervisor.request("approval.displayed", { approvalId: a.id, nonce: a.nonce }).then(() => supervisor.request("approval.decide", { approvalId: a.id, nonce: a.nonce, intentHash: a.intentHash, decision: process.env.MIDNIGHT_SELFTEST_ASK === "no" ? "decline" : "approve" }));
				}
				if (m.type === "action.prepared") console.log(`\n[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m.mission.feed.at(-1)?.text}`);
				if (m.type === "mission.completed") resolve(m.mission);
			};
		});
		const r = await supervisor.request("mission.create", { text: prompt, requestId: `selftest-${Date.now()}` });
		console.log(`[mission] ${r.missionId}`);
		const m = await done;
		console.log(`\n[outcome] ${m.outcome?.status} · ${m.outcome?.summary} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
		await supervisor.stop();
		app.exit(m.outcome?.status === "succeeded" ? 0 : 1);
	}
	app.on("before-quit", () => {
		app.isQuitting = true;
	});
	app.on("will-quit", async (e) => {
		globalShortcut.unregisterAll();
		if (supervisor && supervisor.state() !== "stopped") {
			e.preventDefault();
			await supervisor.stop();
			stopComputer();
			web?.dispose();
			browsers?.dispose();
			app.exit(0);
		}
	});
	app.on("window-all-closed", () => {});
}
