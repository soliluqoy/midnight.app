import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

export const SETTINGS_VERSION = 2;

export const DEFAULTS = {
	version: SETTINGS_VERSION,
	engine: "mission", // mission | legacy (the 0.1 engine, kept for rollback)
	provider: "", // "" = choose automatically from what you are signed in to
	model: "",
	thinking: "low", // off | low | medium | high
	computerUse: "ask", // ask = allowed once a plan that needs it is approved | never
	hotkey: "CommandOrControl+Alt+M",
	corner: "right", // right | left
	launchAtLogin: false,
	instructions: "", // standing instructions appended to the system prompt
	// reading
	textSize: 1, // zoom for the whole capsule: 0.9 … 1.6
	highContrast: false,
	reducedMotion: false,
	autoExpand: true, // open the wide reading view when an answer is long
	answerLength: "normal", // brief | normal | detailed
	// web
	searchEngine: "google", // google | bing | duckduckgo (falls back to the others when blocked)
	fastPages: true, // fetch pages without a window when possible; block images, media, fonts and trackers otherwise
	autoApproveReadOnly: true, // legacy engine only
	shareContext: true, // tell the model which window / page the user was on when they opened the capsule
	// autonomy (mission engine)
	onboarded: false,
	mode: "ask", // ask | prepare | rules
	privacy: "cloud", // cloud | local | offline
	profile: "balanced", // quiet | balanced | focused | burst
	local: { enabled: false, baseUrl: "http://localhost:11434/v1", model: "", vision: false },
	quietHours: { enabled: true, from: "22:00", to: "07:00" },
	budget: { costUsd: 2, toolCalls: 300 },
	demoConnectors: false,
	updates: "notify", // notify | off: read the public release feed at most daily; installs only when you ask
	display: "", // id of the monitor the capsule lives on ("" = the one with the cursor at start)
};

const file = () => path.join(app.getPath("userData"), "settings.json");

/**
 * Import of v1 settings (plan ch. 19, step 6): known keys map one to one; unknown keys are kept; the original file is
 * copied once to settings.v1.json before anything is rewritten, so a repeated import is a no-op.
 */
export function migrateSettings(data, dir) {
	if ((data.version ?? 1) >= SETTINGS_VERSION) return data;
	const backup = path.join(dir, "settings.v1.json");
	if (!fs.existsSync(backup)) fs.writeFileSync(backup, JSON.stringify(data, null, 2));
	const out = { ...data, version: SETTINGS_VERSION };
	// Meaning changed: v1 shared the foreground window by default; that stays, but autonomy starts at "Ask me".
	out.mode = "ask";
	out.onboarded = false;
	return out;
}

export function loadSettings() {
	let data = {};
	try {
		data = JSON.parse(fs.readFileSync(file(), "utf8"));
	} catch {}
	try {
		data = migrateSettings(data, path.dirname(file()));
	} catch {}
	const s = { ...DEFAULTS };
	const unknown = {};
	for (const [k, v] of Object.entries(data)) {
		if (!(k in DEFAULTS)) unknown[k] = v;
		else if (typeof v === typeof DEFAULTS[k] && (typeof v !== "object" || (v && !Array.isArray(v)))) s[k] = typeof v === "object" ? { ...DEFAULTS[k], ...v } : v;
	}
	s.textSize = Math.min(1.6, Math.max(0.9, s.textSize));
	const write = () => {
		fs.mkdirSync(path.dirname(file()), { recursive: true });
		const tmp = `${file()}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify({ ...unknown, ...s }, null, 2));
		fs.renameSync(tmp, file());
	};
	if ((data.version ?? 1) !== SETTINGS_VERSION || !fs.existsSync(file())) {
		try {
			write();
		} catch {}
	}
	return {
		get: () => structuredClone(s), // a copy, so callers can compare before/after a set()
		set(patch) {
			for (const k of Object.keys(patch)) {
				if (!(k in DEFAULTS) || k === "version") continue;
				const v = patch[k];
				if (typeof v !== typeof DEFAULTS[k]) continue;
				s[k] = typeof v === "object" && v && !Array.isArray(v) ? { ...s[k], ...v } : v;
			}
			s.textSize = Math.min(1.6, Math.max(0.9, Math.round(s.textSize * 100) / 100));
			if (!["ask", "prepare", "rules"].includes(s.mode)) s.mode = "ask";
			if (!["cloud", "local", "offline"].includes(s.privacy)) s.privacy = "cloud";
			if (!["quiet", "balanced", "focused", "burst"].includes(s.profile)) s.profile = "balanced";
			write();
			return structuredClone(s);
		},
	};
}

/** The part of the settings the agent host needs. */
export const hostSettings = (s) => ({
	provider: s.provider,
	model: s.model,
	thinking: s.thinking,
	answerLength: s.answerLength,
	instructions: s.instructions,
	mode: s.mode,
	privacy: s.privacy,
	computerUse: s.computerUse,
	local: s.local,
	budget: s.budget,
	profile: s.profile,
	quietHours: s.quietHours,
	demoConnectors: s.demoConnectors,
});
