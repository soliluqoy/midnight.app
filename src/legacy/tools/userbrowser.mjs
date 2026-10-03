import { execFile } from "node:child_process";
import { shell } from "electron";
import { Type } from "typebox";
import { BROWSERS, browserUrl, lastForeground, listWindows, normalizeUrl } from "./computer.mjs";

// The user's own browser (their default: Chrome, Edge, Firefox…): read which page they are on, open pages there.
// Driving it (clicking, typing) is computer use and needs an approved plan; this tool never touches input.

const PROGIDS = [
	[/^ChromeHTML/i, "Chrome", "chrome"],
	[/^MSEdge/i, "Edge", "msedge"],
	[/^Firefox/i, "Firefox", "firefox"],
	[/^Brave/i, "Brave", "brave"],
	[/^Opera/i, "Opera", "opera"],
	[/^Vivaldi/i, "Vivaldi", "vivaldi"],
	[/^Arc/i, "Arc", "arc"],
	[/^Zen/i, "Zen", "zen"],
];

let cachedDefault;
export function defaultBrowser() {
	if (cachedDefault) return cachedDefault;
	if (process.platform !== "win32") {
		cachedDefault = Promise.resolve({ name: "the default browser", proc: "", progId: "" });
		return cachedDefault;
	}
	cachedDefault = new Promise((resolve) => {
		execFile(
			"reg",
			["query", "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice", "/v", "ProgId"],
			{ windowsHide: true, timeout: 4000 },
			(err, out) => {
				const id = err ? "" : (String(out).match(/ProgId\s+REG_SZ\s+(\S+)/) ?? [])[1] ?? "";
				const hit = PROGIDS.find(([re]) => re.test(id));
				resolve(hit ? { name: hit[1], proc: hit[2], progId: id } : { name: id || "unknown", proc: "", progId: id });
			},
		);
	});
	return cachedDefault;
}

const pretty = (proc) => PROGIDS.find((x) => x[2] === proc)?.[1] ?? proc;
const ago = (t) => {
	const s = Math.round((Date.now() - t) / 1000);
	return s < 90 ? `${s}s ago` : `${Math.round(s / 60)} min ago`;
};

/** A one-line picture of where the user is, added to each prompt so routing needs no extra tool call. */
export async function userContext() {
	const db = await defaultBrowser();
	const fg = lastForeground();
	const parts = [`default browser: ${db.name}`];
	if (fg && Date.now() - fg.at < 30 * 60 * 1000) {
		const inBrowser = BROWSERS.has(fg.proc);
		parts.push(
			`when they opened midnight they were in ${inBrowser ? pretty(fg.proc) : fg.proc}: "${fg.title.slice(0, 120)}"${fg.url ? ` <${fg.url}>` : ""} (${ago(fg.at)})`,
		);
	}
	return parts.join(" · ");
}

async function browserWindows() {
	const db = await defaultBrowser();
	const wins = (await listWindows()).filter((w) => BROWSERS.has(w.proc));
	return { db, wins };
}

// The window the user most likely means by "this page": the one they came from, else the topmost browser window.
async function pickWindow(spec) {
	const { db, wins } = await browserWindows();
	if (spec) {
		const q = spec.toLowerCase();
		return wins.find((w) => String(w.hwnd) === spec || w.title.toLowerCase().includes(q) || w.proc.includes(q));
	}
	const fg = lastForeground();
	if (fg && BROWSERS.has(fg.proc)) return wins.find((w) => w.hwnd === fg.hwnd) ?? fg;
	return wins.find((w) => !w.min && w.proc === db.proc) ?? wins.find((w) => !w.min) ?? wins[0];
}

const looksWalled = (t) =>
	t.length < 1200 && /\b(sign in|log in|login|password|verify you are human|enable javascript|subscribe to continue|access denied)\b/i.test(t);

export function userBrowserTool(web) {
	return {
		name: "user_browser",
		label: "Your browser",
		description:
			"The user's own default browser (with their logins and open tabs). `status`: default browser, open browser windows and which page " +
			"the user was on. `current_page`: read the page in the user's active tab (URL from the address bar, text loaded in the background, " +
			"without their cookies). `open`: open URLs in the user's browser for them to see. Never clicks or types; driving the user's browser " +
			"is computer use.",
		promptSnippet: "user_browser: see/read the page the user has open in their own browser, or open pages there",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("status"), Type.Literal("current_page"), Type.Literal("open")]),
			urls: Type.Optional(Type.Array(Type.String(), { maxItems: 5, description: "open: URLs to open, each in a new tab" })),
			window: Type.Optional(Type.String({ description: "current_page: window handle or title part, if not the most recent one" })),
			query: Type.Optional(Type.String({ description: "current_page: what you are looking for; focuses long pages" })),
		}),
		async execute(_id, p, signal) {
			const text = (t, details = {}) => ({ content: [{ type: "text", text: t }], details: { action: p.action, ...details } });
			switch (p.action) {
				case "status": {
					const { db, wins } = await browserWindows();
					const fg = lastForeground();
					const lines = [`Default browser: ${db.name}.`];
					lines.push(
						wins.length
							? `Open browser windows (topmost first):\n${wins.map((w) => `- ${w.hwnd} · ${pretty(w.proc)} · ${w.title}${w.min ? " (minimized)" : ""}`).join("\n")}`
							: "No browser windows are open.",
					);
					if (fg) lines.push(`When they opened midnight the user was in ${fg.proc}: "${fg.title}"${fg.url ? ` <${fg.url}>` : ""} (${ago(fg.at)}).`);
					return text(lines.join("\n"));
				}
				case "current_page": {
					const w = await pickWindow(p.window);
					if (!w) return text("No browser window is open. Ask the user for the link, or use search.");
					let url = "";
					const fg = lastForeground();
					if (fg?.hwnd === w.hwnd && fg.url) url = fg.url;
					if (!url) url = normalizeUrl((await browserUrl(w.hwnd).catch(() => null))?.url ?? "");
					if (!/^https?:/i.test(url)) {
						return text(
							`The user's ${pretty(w.proc)} window is "${w.title}" but its address couldn't be read${url ? ` (${url})` : ""}. ` +
								"Look at it with computer use (plan with usesComputer), or ask for the link.",
						);
					}
					const pg = await web.read(url, p.query, signal).catch((err) => ({ url, title: w.title, text: "", error: String(err?.message ?? err) }));
					const walled = !pg.text || looksWalled(pg.text);
					const tip = walled
						? "\n\nNote: this looks like a login wall or an empty shell. The content is behind the user's session. To see what they see, use computer use on their browser (screenshot/zoom/elements) after a plan with usesComputer, or ask them to paste it."
						: "";
					return text(
						`${pretty(w.proc)} tab: ${w.title}\n${pg.url}\n\n${pg.text || pg.error || "(no readable text)"}${tip}`,
						{ urls: [pg.url] },
					);
				}
				case "open": {
					const urls = (p.urls ?? []).map(normalizeUrl).filter((u) => /^https?:\/\//i.test(u));
					if (!urls.length) throw new Error("open needs http(s) urls");
					for (const u of urls) await shell.openExternal(u);
					const db = await defaultBrowser();
					return text(`Opened ${urls.length} page${urls.length === 1 ? "" : "s"} in the user's ${db.name}.`, { urls });
				}
			}
		},
	};
}
