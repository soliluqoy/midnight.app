// The web worker without Electron: plain fetch for search results and pages, same tool output as `web.mjs`.
// Used by the eval runner so research scenarios touch the real web. Pages that only render with scripts come back
// short; the model sees that, as it would when the shell's window fallback also fails.
import { dedupeSearchRuns } from "../harness-utils.mjs";
import { READ_PAGES, SEARCH } from "./schemas.mjs";
import { focus, htmlToText, parseSerp, SERP_URL } from "./web-text.mjs";

const PAGE_CHARS = 7000;
const TIMEOUT = 12000;
const MAX_HTML = 3_000_000;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

/** @param {{ fetch?: typeof fetch, engines?: string[] }} [o] */
export function createHeadlessWeb(o = {}) {
	const doFetch = o.fetch ?? globalThis.fetch;
	const engines = o.engines ?? ["duckduckgo", "bing"];
	const cache = new Map();

	async function get(url, signal) {
		const res = await doFetch(url, {
			headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5", "accept-language": "en" },
			redirect: "follow",
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT)]) : AbortSignal.timeout(TIMEOUT),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const type = res.headers.get("content-type") ?? "";
		const body = (await res.text()).slice(0, MAX_HTML);
		return { url: res.url || url, type, body };
	}

	async function readOne(url, signal) {
		const hit = cache.get(url);
		if (hit) return hit;
		const r = await get(url, signal);
		let page;
		if (/html|xml/i.test(r.type) || /^\s*</.test(r.body)) {
			const x = htmlToText(r.body);
			page = { url: r.url, title: x.title || url, desc: x.desc, text: x.text };
		} else if (/^text\/|json/i.test(r.type)) page = { url: r.url, title: url, desc: "", text: r.body };
		else throw new Error(`unsupported content type ${r.type || "unknown"}`);
		cache.set(url, page);
		return page;
	}

	async function search(q, signal) {
		let last = { results: [], answer: "", engine: engines[0] };
		for (const e of engines) {
			try {
				const r = parseSerp(e, (await get(SERP_URL[e](q), signal)).body);
				last = { ...r, engine: e };
				if (r.results.length) return last;
			} catch (err) {
				if (signal?.aborted) throw err;
			}
		}
		return last;
	}

	const text = (t, details = {}) => ({ content: [{ type: "text", text: t }], details });

	const searchTool = {
		...SEARCH,
		async execute(_id, p, signal) {
			const runs = dedupeSearchRuns(await Promise.all(p.queries.slice(0, 4).map((q) => search(q, signal).then((r) => ({ q, ...r })))));
			const lines = [];
			const urls = [];
			for (const r of runs) {
				lines.push(`## ${r.q}  (${r.engine})`);
				if (!r.results.length) lines.push(r.blocked ? "The engine blocked this search." : "No results.");
				r.results.slice(0, 8).forEach((x, i) => {
					lines.push(`${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`);
					urls.push(x.url);
				});
			}
			return text(lines.join("\n"), { urls });
		},
	};

	const readTool = {
		...READ_PAGES,
		async execute(_id, p, signal) {
			const urls = [...new Set(p.urls.slice(0, 8).map((u) => (/^[a-z]+:\/\//i.test(u) ? u : `https://${u}`)))];
			const budget = Math.max(3000, Math.floor((PAGE_CHARS * 5) / Math.max(5, urls.length)) + (urls.length <= 2 ? 6000 : 0));
			const pages = await Promise.all(urls.map((u) => readOne(u, signal).then((pg) => ({ ok: true, ...pg }), (err) => ({ ok: false, url: u, error: String(err?.message ?? err) }))));
			if (signal?.aborted) throw new Error("aborted");
			const out = pages.map((pg, i) => {
				if (!pg.ok) return `[${i + 1}] ${pg.url}\nCould not load: ${pg.error}`;
				const body = focus(pg.text || pg.desc || "", p.query, budget);
				return `[${i + 1}] ${pg.title}\n${pg.url}\n\n${body || "(no readable text; the page may need a browser)"}`;
			});
			return text(out.join("\n\n---\n\n"), {
				urls: pages.map((pg) => pg.url),
				pages: pages.filter((pg) => pg.ok).map((pg) => ({ url: pg.url, title: pg.title, excerpt: focus(pg.text || pg.desc || "", p.query, 600) })),
			});
		},
	};

	return {
		tools: [searchTool, readTool],
		async read(url, query, signal) {
			const pg = await readOne(url, signal);
			return { ...pg, text: focus(pg.text || pg.desc || "", query, 14000) };
		},
	};
}

/** Platform operations for a host running outside the shell: web reading only; everything else is refused. */
export function headlessWebOps(web) {
	const tool = (name) => web.tools.find((t) => t.name === name);
	return {
		"tool.search": (a, c) => tool("search").execute("s", a, c?.signal),
		"tool.read_pages": (a, c) => tool("read_pages").execute("r", a, c?.signal),
		"fetch.page": async (a, c) => {
			if (!/^https?:\/\//i.test(a.url ?? "")) throw new Error("only http(s) pages");
			const pg = await web.read(a.url, "", c?.signal);
			return { title: pg.title, text: pg.text };
		},
	};
}
