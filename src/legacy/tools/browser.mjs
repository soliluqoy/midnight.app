import { Type } from "typebox";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const Params = Type.Object({
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
});

/** `wc()` returns the WebContents of the embedded browser view. */
export function browserTool(wc) {
	// Wait for a navigation to settle, event-driven: returns as soon as loading stops (max `ms`).
	const waitLoad = async (ms = 12000) => {
		const w = wc();
		if (!w.isLoading()) return sleep(120);
		await new Promise((resolve) => {
			const done = () => {
				clearTimeout(t);
				w.off("did-stop-loading", done);
				resolve();
			};
			const t = setTimeout(done, ms);
			w.on("did-stop-loading", done);
		});
		await sleep(150);
	};
	const shot = async () => {
		const img = await wc().capturePage();
		const s = img.getSize();
		const bounds = await wc().executeJavaScript("({w: innerWidth, h: innerHeight})");
		const r = s.width === bounds.w ? img : img.resize({ width: bounds.w, height: bounds.h });
		return { data: r.toJPEG(80).toString("base64"), w: bounds.w, h: bounds.h };
	};
	const mouse = (type, x, y, extra = {}) =>
		wc().sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1, ...extra });

	return {
		name: "browser",
		label: "Browser",
		description:
			"Use the app's built-in web browser (Chromium, persistent logins) when you must interact with a page: log in, click, " +
			"fill forms. It runs in the background without touching the user's screen. For just reading, prefer `search` and `read_pages`. " +
			"`session` tells whether this browser is signed in to a site. Coordinates are pixels of the latest screenshot. " +
			"Every action except `read` returns a screenshot unless screenshot is false. `read` returns the page's visible text.",
		promptSnippet: "browser: navigate, screenshot, click, type, key, scroll, read in the built-in web browser",
		parameters: Params,
		executionMode: "sequential",
		async execute(_id, p) {
			const w = wc();
			const need = (...k) => {
				for (const f of k) if (p[f] === undefined) throw new Error(`${p.action} needs ${f}`);
			};
			switch (p.action) {
				case "session": {
					// Is midnight's own browser signed in to this site? Decides between it and the user's browser.
					need("url");
					const url = /^[a-z]+:\/\//i.test(p.url) ? p.url : `https://${p.url}`;
					const cookies = await w.session.cookies.get({ url });
					const auth = cookies.filter((c) => /sess|auth|token|sid|login|user|account|jwt|remember/i.test(c.name) && (c.session || c.expirationDate * 1000 > Date.now()));
					const verdict = auth.length ? "probably signed in" : cookies.length ? "has visited, probably not signed in" : "never visited, not signed in";
					return {
						content: [{ type: "text", text: `midnight's browser for ${new URL(url).host}: ${cookies.length} cookies, ${verdict}.` }],
						details: { action: "session", url },
					};
				}
				case "navigate": {
					need("url");
					const url = /^[a-z]+:\/\//i.test(p.url) ? p.url : `https://${p.url}`;
					await Promise.race([w.loadURL(url).catch(() => {}), sleep(12000)]);
					await sleep(150);
					break;
				}
				case "back":
					w.navigationHistory.goBack();
					await waitLoad();
					break;
				case "forward":
					w.navigationHistory.goForward();
					await waitLoad();
					break;
				case "click":
					need("x", "y");
					w.focus();
					mouse("mouseMove", p.x, p.y);
					mouse("mouseDown", p.x, p.y);
					mouse("mouseUp", p.x, p.y);
					await sleep(250); // a click that navigates starts loading within this window
					await waitLoad();
					break;
				case "type":
					need("text");
					await w.insertText(p.text);
					await sleep(200);
					break;
				case "key": {
					need("key");
					const parts = p.key.split("+");
					const keyCode = parts.pop();
					const modifiers = parts.map((m) => m.toLowerCase());
					w.sendInputEvent({ type: "keyDown", keyCode, modifiers });
					if (keyCode.length === 1) w.sendInputEvent({ type: "char", keyCode, modifiers });
					w.sendInputEvent({ type: "keyUp", keyCode, modifiers });
					await sleep(200);
					await waitLoad(); // Enter often submits a form
					break;
				}
				case "scroll":
					need("x", "y", "dy");
					w.sendInputEvent({ type: "mouseWheel", x: p.x, y: p.y, deltaX: 0, deltaY: -p.dy });
					await sleep(250);
					break;
				case "read": {
					const text = await w.executeJavaScript("document.body ? document.body.innerText : ''");
					const t = String(text).replace(/\n{3,}/g, "\n\n");
					const body = t.length > 20000 ? `${t.slice(0, 20000)}\n[truncated ${t.length - 20000} chars]` : t;
					return {
						content: [{ type: "text", text: `${w.getTitle()}\n${w.getURL()}\n\n${body}` }],
						details: { action: "read", url: w.getURL() },
					};
				}
			}
			if (p.screenshot === false && p.action !== "screenshot") {
				return {
					content: [{ type: "text", text: `Done: ${p.action}. ${w.getTitle()} — ${w.getURL()}.` }],
					details: { action: p.action, url: w.getURL() },
				};
			}
			const s = await shot();
			return {
				content: [
					{ type: "text", text: `Done: ${p.action}. ${w.getTitle()} — ${w.getURL()}. Screenshot is ${s.w}x${s.h}.` },
					{ type: "image", data: s.data, mimeType: "image/jpeg" },
				],
				details: { action: p.action, url: w.getURL(), image: s.data },
			};
		},
	};
}
