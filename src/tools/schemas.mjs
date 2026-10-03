// Model-facing definitions of the tools that execute in the Electron shell (web, browser, the user's browser,
// desktop). Kept free of Electron imports so the agent host can declare them; the shell executes them on request.
import { Type } from "typebox";

export const SEARCH = {
	name: "search",
	label: "Search",
	description:
		"Web search. Returns the top results (title, URL, snippet) as text in about a second, plus the engine's direct answer if it shows one. " +
		"Pass several queries at once to cover different angles; they run in parallel.",
	promptSnippet: "search: fast web search; returns titles, URLs and snippets (no screenshots)",
	parameters: Type.Object({
		queries: Type.Array(Type.String(), { description: "1-4 search queries", minItems: 1, maxItems: 4 }),
	}),
};

export const READ_PAGES = {
	name: "read_pages",
	label: "Read pages",
	description:
		"Read the main text of 1-8 web pages at once (they load in parallel, text only, no screenshots). " +
		"Pass the user's question as `query` so long pages are trimmed to the relevant passages. Much faster than the browser tool.",
	promptSnippet: "read_pages: read several URLs in parallel as clean text",
	parameters: Type.Object({
		urls: Type.Array(Type.String(), { minItems: 1, maxItems: 8 }),
		query: Type.Optional(Type.String({ description: "What you are looking for; focuses long pages" })),
	}),
};

export const BROWSER = {
	name: "browser",
	label: "Browser",
	description:
		"Use the app's built-in web browser (Chromium, persistent logins) when you must interact with a page: log in, click, " +
		"fill forms. It runs in the background without touching the user's screen; each mission gets its own tab. For just reading, prefer `search` and `read_pages`. " +
		"`session` tells whether this browser is signed in to a site. Coordinates are pixels of the latest screenshot. " +
		"Every action except `read` returns a screenshot unless screenshot is false. `read` returns the page's visible text. " +
		"Clicks or keys that would submit, buy, send, post or delete are checked by Midnight and may wait for the user.",
	promptSnippet: "browser: navigate, screenshot, click, type, key, scroll, read in the built-in web browser",
	executionMode: "sequential",
	parameters: Type.Object({
		action: Type.Union(
			["navigate", "screenshot", "click", "type", "key", "scroll", "read", "back", "forward", "session"].map((a) => Type.Literal(a)),
			{ description: "What to do" },
		),
		url: Type.Optional(Type.String({ description: "URL for navigate; for session, the site to check" })),
		x: Type.Optional(Type.Number({ description: "X in screenshot pixels (page CSS px)" })),
		y: Type.Optional(Type.Number({ description: "Y in screenshot pixels (page CSS px)" })),
		text: Type.Optional(Type.String({ description: "text for type (goes to the focused field)" })),
		key: Type.Optional(Type.String({ description: "key for key: Enter, Tab, Backspace, Escape, ArrowDown, PageDown..." })),
		dy: Type.Optional(Type.Number({ description: "scroll pixels; positive = down" })),
		screenshot: Type.Optional(Type.Boolean({ description: "false skips the screenshot (faster) when you don't need to see the page" })),
	}),
};

export const USER_BROWSER = {
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
};

export const COMPUTER_ACTIONS = [
	"screenshot",
	"elements",
	"read_text",
	"click_element",
	"set_value",
	"click",
	"double_click",
	"right_click",
	"move",
	"drag",
	"type",
	"key",
	"scroll",
	"zoom",
	"windows",
	"focus_window",
	"launch",
	"wait",
];
export const COMPUTER_OBSERVE = new Set(["screenshot", "elements", "read_text", "zoom", "windows", "wait"]);

export const COMPUTER = {
	name: "computer",
	label: "Computer",
	description:
		"Control the user's Windows desktop (any app, including the user's own browser) with mouse and keyboard. " +
		"Most accurate: `elements` lists the clickable controls of a window (from Windows UI Automation) with ids and exact centers; " +
		"then `click_element` / `set_value` by id (a window with no controls returns a screenshot instead). `read_text` returns the exact text of a window or element (documents, editors, the " +
		"page in the user's browser) without a screenshot. Use screenshots to see, `zoom` to read small text, `windows` / `focus_window` " +
		"to switch apps, `launch` to open an app or file. Coordinates are pixels of the most recent screenshot. " +
		"Actions return a fresh screenshot unless screenshot is false. Prefer the `browser`, `search` and `read_pages` tools for web work " +
		"that doesn't need the user's own browser. Midnight holds the screen only while an action runs; the user can press Esc to take over.",
	promptSnippet: "computer: see and control the Windows desktop (elements by id, screenshot, click, type, key, zoom, windows)",
	executionMode: "sequential",
	parameters: Type.Object({
		action: Type.Union(COMPUTER_ACTIONS.map((a) => Type.Literal(a)), { description: "What to do" }),
		x: Type.Optional(Type.Number({ description: "X in screenshot pixels (zoom: region left)" })),
		y: Type.Optional(Type.Number({ description: "Y in screenshot pixels (zoom: region top)" })),
		x2: Type.Optional(Type.Number({ description: "drag end X" })),
		y2: Type.Optional(Type.Number({ description: "drag end Y" })),
		w: Type.Optional(Type.Number({ description: "zoom region width in screenshot pixels" })),
		h: Type.Optional(Type.Number({ description: "zoom region height in screenshot pixels" })),
		id: Type.Optional(Type.Integer({ description: "element id from the latest `elements` list" })),
		window: Type.Optional(Type.String({ description: "window handle (from `windows`) or part of its title / process name" })),
		text: Type.Optional(Type.String({ description: "text for type / set_value" })),
		key: Type.Optional(Type.String({ description: "key or combo for key, e.g. Enter, ctrl+c, ctrl+l, alt+f4, win" })),
		dy: Type.Optional(Type.Number({ description: "scroll amount; positive = down (120 = one notch)" })),
		dx: Type.Optional(Type.Number({ description: "horizontal scroll; positive = right" })),
		target: Type.Optional(Type.String({ description: "launch: app name (notepad, excel, chrome), file path or URL" })),
		seconds: Type.Optional(Type.Number({ description: "seconds for wait (max 10)" })),
		screenshot: Type.Optional(Type.Boolean({ description: "false skips the screenshot after an action (faster when chaining)" })),
	}),
};

/** Words that mark a likely commit point (submit, pay, send...). A hint for classification, never authority. */
export const COMMIT_WORDS = /\b(buy|pay|purchase|order|checkout|place order|send|submit|confirm|delete|remove|book|reserve|post|publish|transfer|sign up|subscribe|unsubscribe|apply|save changes)\b/i;
