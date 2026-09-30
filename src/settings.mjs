import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

export const DEFAULTS = {
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
	autoExpand: true, // open the wide reading view when an answer is long
	answerLength: "normal", // brief | normal | detailed
	// web
	searchEngine: "google", // google | bing | duckduckgo (falls back to the others when blocked)
	fastPages: true, // fetch pages without a window when possible; block images, media, fonts and trackers otherwise
	autoApproveReadOnly: true, // plans that only read (no sends, no desktop) run without the Approve click
	shareContext: true, // tell the model which window / page the user was on when they opened the capsule
};

const file = () => path.join(app.getPath("userData"), "settings.json");

export function loadSettings() {
	let data = {};
	try {
		data = JSON.parse(fs.readFileSync(file(), "utf8"));
	} catch {}
	const s = { ...DEFAULTS };
	for (const k of Object.keys(DEFAULTS)) if (typeof data[k] === typeof DEFAULTS[k]) s[k] = data[k];
	s.textSize = Math.min(1.6, Math.max(0.9, s.textSize));
	return {
		get: () => ({ ...s }), // a copy, so callers can compare before/after a set()
		set(patch) {
			for (const k of Object.keys(patch)) if (k in DEFAULTS && typeof patch[k] === typeof DEFAULTS[k]) s[k] = patch[k];
			s.textSize = Math.min(1.6, Math.max(0.9, Math.round(s.textSize * 100) / 100));
			fs.mkdirSync(path.dirname(file()), { recursive: true });
			fs.writeFileSync(file(), JSON.stringify(s, null, 2));
			return { ...s };
		},
	};
}
