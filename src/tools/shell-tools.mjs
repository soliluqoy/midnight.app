// Host-side specs for the tools that execute in the Electron shell. The host classifies each call (Midnight's own
// effect classes; a click is judged by what it may do, not by its size), records evidence for what was read, and
// asks the shell to execute. Desktop input carries the screen-lease epoch; the shell refuses stale epochs.
import { BROWSER, COMMIT_WORDS, COMPUTER, COMPUTER_OBSERVE, READ_PAGES, SEARCH, USER_BROWSER } from "./schemas.mjs";

const host = (u) => {
	try {
		return new URL(/^[a-z]+:\/\//i.test(u) ? u : `https://${u}`).host.replace(/^www\./, "");
	} catch {
		return String(u);
	}
};
const clip = (s, n = 40) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
const fixUrl = (u) => (/^[a-z]+:\/\//i.test(u) ? u : `https://${u}`);

/**
 * @param {{ platform: { call: (op: string, args: object, o?: object) => Promise<any> }, evidence: object, commit: Function }} deps
 */
export function shellTools({ platform, evidence, commit }) {
	const recordPages = (missionId, pages) => {
		if (!pages?.length) return;
		commit(() => {
			for (const pg of pages) {
				if (!pg?.url) continue;
				evidence.record(missionId, { kind: "web", source: pg.url, locator: { title: pg.title ?? "" }, excerpt: pg.excerpt, hash: pg.hash, freshness: pg.date });
			}
		});
	};

	const search = {
		...SEARCH,
		version: "1",
		classify: (a) => ({
			effect: "read.web",
			network: true,
			target: (a.queries ?? []).join(" | "),
			canonical: { queries: a.queries },
			feed: `search › ${(a.queries ?? []).map((q) => `“${clip(q, 36)}”`).join(" · ")}`,
			icon: "⌕",
		}),
		async execute(a, ctx) {
			const out = await platform.call("tool.search", a, { signal: ctx.signal });
			return { content: out.content, details: out.details };
		},
	};

	const readPages = {
		...READ_PAGES,
		version: "1",
		classify: (a) => {
			const urls = [...new Set((a.urls ?? []).map(fixUrl))];
			return { effect: "read.web", network: true, target: urls.join(" "), canonical: { urls, query: a.query ?? "" }, feed: `read ${urls.length} page${urls.length === 1 ? "" : "s"} › ${urls.map(host).join(", ")}` };
		},
		async execute(a, ctx) {
			const out = await platform.call("tool.read_pages", a, { signal: ctx.signal });
			recordPages(ctx.missionId, out.details?.pages);
			return { content: out.content, details: { urls: out.details?.urls } };
		},
	};

	const browser = {
		...BROWSER,
		version: "1",
		async classify(a, { mission }) {
			const base = { network: true, canonical: a, target: a.url ? fixUrl(a.url) : a.action };
			const where = a.action === "navigate" ? `open ${host(a.url ?? "")}` : a.action === "read" ? "read page" : a.action === "session" ? `check sign-in · ${host(a.url ?? "")}` : a.action;
			if (["navigate", "screenshot", "read", "back", "forward", "session", "scroll"].includes(a.action) || a.action === "type") {
				return { ...base, effect: "browser.navigate", feed: `browser › ${where}${a.action === "type" ? ` “${clip(a.text ?? "", 30)}”` : ""}` };
			}
			// click / key: ask the shell what is under the pointer or focused; a likely commit point needs authority.
			const probe = await platform.call("inspect.browser", { missionId: mission.id, action: a.action, x: a.x, y: a.y, key: a.key }).catch(() => ({}));
			const label = probe.label ? ` “${clip(probe.label, 30)}”` : "";
			if (probe.commit || (a.action === "key" && /^enter$/i.test(a.key ?? "") && probe.inForm)) {
				return {
					...base,
					effect: "browser.commit",
					target: `${probe.origin ?? ""} ${probe.label ?? a.key ?? ""}`.trim(),
					destinations: probe.origin ? [probe.origin] : [],
					canonical: { ...a, origin: probe.origin, label: probe.label, form: probe.form },
					display: {
						title: `Press “${clip(probe.label ?? a.key ?? "submit", 40)}” on ${probe.origin ?? "a website"}`,
						verb: "Allow this click",
						consequence: "This may submit a form, send a message or make a purchase on that website.",
						preview: probe.form ? `Form: ${probe.form}` : undefined,
					},
					feed: `browser › ${a.action}${label} (may submit)`,
				};
			}
			return { ...base, effect: "browser.navigate", feed: `browser › ${a.action}${label}` };
		},
		async execute(a, ctx) {
			const out = await platform.call("tool.browser", { ...a, missionId: ctx.missionId }, { signal: ctx.signal });
			if (a.action === "read" && out.details?.url) recordPages(ctx.missionId, [{ url: out.details.url, title: out.details.title, excerpt: out.details.excerpt }]);
			return { content: out.content, details: out.details };
		},
	};

	const userBrowser = {
		...USER_BROWSER,
		version: "1",
		classify: (a) =>
			a.action === "open"
				? { effect: "open.user", target: (a.urls ?? []).join(" "), canonical: a, feed: `your browser › open ${(a.urls ?? []).map(host).join(", ")}`, icon: "↗" }
				: { effect: "read.web", network: a.action === "current_page", target: a.action, canonical: a, feed: a.action === "current_page" ? "your browser › read the page you're on" : "your browser › check open windows" },
		async execute(a, ctx) {
			const out = await platform.call("tool.user_browser", a, { signal: ctx.signal });
			if (a.action === "current_page") recordPages(ctx.missionId, out.details?.pages);
			return { content: out.content, details: out.details };
		},
	};

	const computer = {
		...COMPUTER,
		version: "1",
		async classify(a, { mission }) {
			const observe = COMPUTER_OBSERVE.has(a.action);
			const at = a.x !== undefined ? ` (${Math.round(a.x)},${Math.round(a.y)})` : "";
			const feed =
				{
					elements: `desktop › map controls${a.window ? ` · ${clip(a.window, 30)}` : ""}`,
					read_text: `desktop › read text${a.window ? ` · ${clip(a.window, 30)}` : ""}`,
					screenshot: "desktop › look at the screen",
					zoom: "desktop › zoom in",
					windows: "desktop › list windows",
					wait: "desktop › wait",
					click_element: `desktop › click control #${a.id}`,
					set_value: `desktop › fill #${a.id} “${clip(a.text ?? "", 30)}”`,
					type: `desktop › type “${clip(a.text ?? "", 40)}”`,
					key: `desktop › press ${a.key}`,
					focus_window: `desktop › switch to ${clip(a.window ?? "", 30)}`,
					launch: `desktop › open ${clip(a.target ?? "", 34)}`,
				}[a.action] ?? `desktop › ${a.action.replace("_", " ")}${at}`;
			if (observe) return { effect: "desktop.observe", target: a.window ?? a.action, canonical: a, feed, icon: "◎" };
			// Input: judge likely commit points by the control's name (from the shell's latest element list).
			const probe = ["click_element", "key", "click", "double_click"].includes(a.action)
				? await platform.call("inspect.computer", { missionId: mission.id, action: a.action, id: a.id, key: a.key }).catch(() => ({}))
				: {};
			const commit = (probe.label && COMMIT_WORDS.test(probe.label)) || (a.action === "key" && /^(ctrl\+)?enter$/i.test(a.key ?? "") && probe.commitContext);
			return {
				effect: commit ? "browser.commit" : "desktop.input",
				screen: true,
				target: probe.window ?? a.window ?? a.target ?? a.action,
				canonical: { ...a, label: probe.label, window: probe.window },
				feed: commit ? `${feed} “${clip(probe.label ?? a.key, 30)}” (may submit)` : feed,
				display: commit
					? { title: `Press “${clip(probe.label ?? a.key, 40)}” in ${probe.window ?? "an app"}`, verb: "Allow this click", consequence: "This may send, submit, buy or delete something in that app." }
					: undefined,
				lockTimeoutMs: 15000,
			};
		},
		async execute(a, ctx) {
			const out = await platform.call("tool.computer", { ...a, missionId: ctx.missionId, epoch: ctx.lease?.epoch }, { signal: ctx.signal });
			return { content: out.content, details: { action: a.action } };
		},
	};

	return { search, readPages, browser, userBrowser, computer, all: [search, readPages, browser, userBrowser, computer] };
}
