import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

export const SETTINGS_VERSION = 2;

export const DEFAULTS = {
	version: SETTINGS_VERSION,
	provider: "", // "" = choose automatically from what you are signed in to
	model: "",
	taskModel: "", // "provider|id" for plans, computer use and research; "" = a stronger model when "model" is the fast default
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

export function loadSettings() {
	let data = {};
	try {
		data = JSON.parse(fs.readFileSync(file(), "utf8"));
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
	if (data.version !== SETTINGS_VERSION || !fs.existsSync(file())) {
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
	taskModel: s.taskModel,
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
