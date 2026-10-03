import { BrowserWindow, session as electronSession } from "electron";
import { Type } from "typebox";
import { dedupeSearchRuns } from "../harness-utils.mjs";

// Fast, text-only web access: search results as data and parallel page reading in a small pool of hidden
// windows, with images, media, fonts and trackers blocked. The interactive `browser` tool stays for clicking.

const PARTITION = "persist:midnight-research";
const POOL = 4;
const TTL = 30 * 60 * 1000;
const PAGE_CHARS = 7000; // per page, after trimming to the passages that match the query
const FETCH_TIMEOUT = 5000; // plain fetch before falling back to a window
const MAX_HTML = 3_000_000;
const PREFETCH = 4; // top results fetched while the model reads the result list
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BLOCK_TYPES = new Set(["image", "media", "font", "object", "ping", "cspReport"]);
const BLOCK_HOSTS =
	/(^|\.)(doubleclick\.net|googlesyndication\.com|googletagmanager\.com|google-analytics\.com|googleadservices\.com|adservice\.google\.[a-z.]+|facebook\.net|connect\.facebook\.net|amazon-adsystem\.com|taboola\.com|outbrain\.com|scorecardresearch\.com|hotjar\.com|criteo\.(com|net)|adnxs\.com|quantserve\.com|chartbeat\.(com|net)|moatads\.com|pubmatic\.com|rubiconproject\.com|segment\.(io|com)|mixpanel\.com|clarity\.ms)$/i;

// ---- page scripts (run inside the page) ----

// Main-content extraction: drop chrome (nav, footers, ads), pick the densest content root, emit light markdown.
// Takes a document so it runs on the live page and on HTML parsed with DOMParser alike.
const EXTRACT_FN = `((document) => {
  const clone = document.body ? document.body.cloneNode(true) : null;
  if (!clone) return { title: document.title, text: "" };
  clone.querySelectorAll('script,style,noscript,svg,canvas,iframe,form,button,input,select,textarea,nav,header,footer,aside,dialog,[role=navigation],[role=banner],[role=contentinfo],[role=complementary],[aria-hidden=true],[hidden],.ad,.ads,.advert,.advertisement,.cookie,.cookies,.consent,.newsletter,.share,.social,.related,.comments,#comments,.sidebar,.breadcrumb,.breadcrumbs,.menu,.nav,.navbar,.footer,.header,.popup,.modal').forEach((e) => e.remove());
  const cands = [...clone.querySelectorAll('article,main,[role=main],#content,#main,.content,.post,.article,.entry-content,.post-content,.article-body,.markdown-body')];
  const score = (el) => [...el.querySelectorAll('p,li,pre,td')].reduce((n, p) => n + p.textContent.trim().length, 0);
  let root = clone, best = 0;
  for (const c of cands) { const s = score(c); if (s > best) { best = s; root = c; } }
  if (best < 400) {
    const counts = new Map();
    clone.querySelectorAll('p').forEach((p) => { const par = p.parentElement; if (par) counts.set(par, (counts.get(par) || 0) + p.textContent.trim().length); });
    for (const [el, n] of counts) if (n > best) { best = n; root = el; }
    if (best < 400) root = clone;
  }
  const out = [];
  const clean = (s) => s.replace(/\\s+/g, ' ').trim();
  const walk = (el) => {
    for (const n of el.children) {
      const t = n.tagName;
      if (/^H[1-6]$/.test(t)) { const s = clean(n.textContent); if (s) out.push('#'.repeat(+t[1]) + ' ' + s); }
      else if (t === 'P' || t === 'BLOCKQUOTE' || t === 'DD' || t === 'DT' || t === 'FIGCAPTION') { const s = clean(n.textContent); if (s) out.push(s); }
      else if (t === 'LI') { const s = clean(n.textContent); if (s) out.push('- ' + s); }
      else if (t === 'PRE') { const s = n.textContent.trim(); if (s) out.push('\`\`\`\\n' + s.slice(0, 3000) + '\\n\`\`\`'); }
      else if (t === 'TR') { const cells = [...n.children].map((c) => clean(c.textContent)); if (cells.some(Boolean)) out.push('| ' + cells.join(' | ') + ' |'); }
      else if (n.children.length) walk(n);
      else { const s = clean(n.textContent); if (s.length > 40) out.push(s); }
    }
  };
  walk(root);
  let text = out.join('\\n\\n');
  if (text.length < 200) text = (root.innerText || '').replace(/\\n{3,}/g, '\\n\\n');
  const desc = document.querySelector('meta[name=description],meta[property="og:description"]')?.content || '';
  return { title: document.title, text, desc };
})`;
const EXTRACT = `${EXTRACT_FN}(document)`;

const SERP = {
	google: {
		url: (q) => `https://www.google.com/search?hl=en&num=10&q=${encodeURIComponent(q)}`,
		js: `(() => {
      const out = [], seen = new Set();
      const answer = (document.querySelector('.hgKElc, .IZ6rdc, .kno-rdesc span, [data-attrid="wa:/description"], .Z0LcW, .LGOjhe') || {}).innerText || '';
      for (const h3 of document.querySelectorAll('a h3')) {
        const a = h3.closest('a'); let href = a.href;
        try { const u = new URL(href); if (u.pathname === '/url') href = u.searchParams.get('q') || u.searchParams.get('url') || href; } catch {}
        if (!/^https?:/.test(href) || /(^|\\.)google\\.[a-z.]+\\//.test(href.replace(/^https?:\\/\\//, '')) || seen.has(href)) continue;
        seen.add(href);
        const box = h3.closest('div.g, div.MjjYud, div[data-hveid]') || a.parentElement;
        const sn = box && (box.querySelector('.VwiC3b, [data-sncf], div[style*="-webkit-line-clamp"]') || null);
        let snippet = sn ? sn.innerText : (box ? box.innerText.replace(h3.innerText, '') : '');
        out.push({ title: h3.innerText.trim(), url: href, snippet: snippet.replace(/\\s+/g, ' ').trim().slice(0, 320) });
      }
      return { results: out, answer: answer.trim().slice(0, 600), blocked: /\\/sorry\\//.test(location.pathname) || !!document.querySelector('#captcha-form, form[action*="sorry"]') };
    })()`,
	},
	bing: {
		url: (q) => `https://www.bing.com/search?setlang=en&q=${encodeURIComponent(q)}`,
		js: `(() => {
      const out = [];
      for (const li of document.querySelectorAll('li.b_algo')) {
        const a = li.querySelector('h2 a'); if (!a) continue;
        let href = a.href;
        try { const u = new URL(href); const enc = u.searchParams.get('u'); if (u.host.endsWith('bing.com') && enc && enc.startsWith('a1')) href = atob(enc.slice(2).replace(/-/g, '+').replace(/_/g, '/')); } catch {}
        const sn = li.querySelector('.b_caption p, .b_lineclamp2, .b_lineclamp3, .b_algoSlug');
        out.push({ title: a.innerText.trim(), url: href, snippet: (sn ? sn.innerText : '').replace(/\\s+/g, ' ').trim().slice(0, 320) });
      }
      const answer = (document.querySelector('.b_focusTextLarge, .b_focusTextMedium, .rwrl') || {}).innerText || '';
      return { results: out, answer: answer.trim().slice(0, 600), blocked: false };
    })()`,
	},
	duckduckgo: {
		url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
		js: `(() => {
      const out = [];
      for (const r of document.querySelectorAll('.result')) {
        const a = r.querySelector('.result__a'); if (!a) continue;
        let href = a.href;
        try { const u = new URL(href); const g = u.searchParams.get('uddg'); if (g) href = g; } catch {}
        if (/duckduckgo\\.com\\/y\\.js/.test(href)) continue;
        const sn = r.querySelector('.result__snippet');
        out.push({ title: a.innerText.trim(), url: href, snippet: (sn ? sn.innerText : '').replace(/\\s+/g, ' ').trim().slice(0, 320) });
      }
      return { results: out, answer: '', blocked: !!document.querySelector('.anomaly-modal') };
    })()`,
	},
};

// Keep the passages that match the query, in page order, within the budget.
function focus(text, query, budget) {
	if (text.length <= budget) return text;
	const paras = text.split(/\n{2,}/);
	const terms = (query ?? "")
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((w) => w.length > 2);
	if (!terms.length) return `${text.slice(0, budget)}\n[… trimmed ${text.length - budget} chars]`;
	const scored = paras.map((p, i) => {
		const l = p.toLowerCase();
		let s = i < 3 ? 2 : 0; // the opening usually frames the page
		for (const t of terms) if (l.includes(t)) s += 1 + Math.min(3, l.split(t).length - 2) * 0.3;
		if (/^#/.test(p)) s += 0.5;
		return { i, p, s };
	});
	const keep = new Set();
	let used = 0;
	for (const x of [...scored].sort((a, b) => b.s - a.s || a.i - b.i)) {
		if (x.s <= 0 && used > budget * 0.5) break;
		if (used + x.p.length > budget) continue;
		keep.add(x.i);
		used += x.p.length + 2;
	}
	let prev = -1;
	const parts = [];
	for (const x of scored) {
		if (!keep.has(x.i)) continue;
		if (x.i !== prev + 1 && parts.length) parts.push("[…]");
		parts.push(x.p);
		prev = x.i;
	}
	return parts.join("\n\n");
}

export function createWeb(settings) {
	const ses = electronSession.fromPartition(PARTITION);
	ses.setUserAgent(ses.getUserAgent().replace(/\s*Electron\/\S+/, "").replace(/\s*midnight-app\/\S+/, ""));
	ses.webRequest.onBeforeRequest((d, cb) => {
		if (!settings.get().fastPages || d.resourceType === "mainFrame") return cb({});
		let host = "";
		try {
			host = new URL(d.url).hostname;
		} catch {}
		cb({ cancel: BLOCK_TYPES.has(d.resourceType) || BLOCK_HOSTS.test(host) });
	});

	const cache = new Map(); // key -> {t, v}
	const cached = (k) => {
		const e = cache.get(k);
		if (e && Date.now() - e.t < TTL) return e.v;
		cache.delete(k);
		return undefined;
	};
	const remember = (k, v) => {
		cache.set(k, { t: Date.now(), v });
		if (cache.size > 200) cache.delete(cache.keys().next().value);
	};

	// Concurrent requests for the same thing share one load; a blocked engine is skipped for a while.
	const inflight = new Map();
	const once = (k, fn) => {
		let p = inflight.get(k);
		if (!p) inflight.set(k, (p = fn().finally(() => inflight.delete(k))));
		return p;
	};
	const blocked = new Map(); // engine -> until

	// ---- window pool ----
	const idle = [];
	const all = new Set();
	const queue = [];
	const make = () => {
		const w = new BrowserWindow({
			show: false,
			width: 1280,
			height: 900,
			webPreferences: { partition: PARTITION, backgroundThrottling: false, images: false, spellcheck: false, sandbox: true },
		});
		w.webContents.setAudioMuted(true);
		w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
		w.webContents.on("will-prevent-unload", (e) => e.preventDefault());
		all.add(w);
		return w;
	};
	const acquire = () =>
		new Promise((resolve) => {
			const w = idle.pop();
			if (w && !w.isDestroyed()) return resolve(w);
			if (all.size < POOL) return resolve(make());
			queue.push(resolve);
		});
	const release = (w) => {
		if (w.isDestroyed()) {
			all.delete(w);
			return queue.shift()?.(make());
		}
		const next = queue.shift();
		if (next) next(w);
		else idle.push(w);
	};

	// Load a URL and wait just long enough for text: DOM ready, then until the load ends or a short grace passes.
	async function load(w, url, signal, { hard = 12000, grace = 2500 } = {}) {
		const wc = w.webContents;
		let done = false;
		let onEnd, onReady;
		const finished = new Promise((r) => {
			onEnd = () => {
				done = true;
				r();
			};
			wc.on("did-finish-load", onEnd);
			wc.on("did-fail-load", onEnd);
		});
		const ready = new Promise((r) => {
			onReady = r;
			wc.on("dom-ready", onReady);
		});
		const aborted = new Promise((r) => signal?.addEventListener("abort", r, { once: true }));
		wc.loadURL(url).catch(() => {});
		try {
			await Promise.race([ready, finished, sleep(hard), aborted]);
			if (!done && !signal?.aborted) await Promise.race([finished, sleep(grace), aborted]);
		} finally {
			wc.off("did-finish-load", onEnd);
			wc.off("did-fail-load", onEnd);
			wc.off("dom-ready", onReady);
		}
		if (signal?.aborted) {
			wc.stop();
			throw new Error("aborted");
		}
	}

	// Plain fetch first; a window only when the page needs one (script-rendered, challenged, not HTML).
	async function readOne(url, signal) {
		const key = `page:${url}`;
		let page = cached(key);
		if (!page)
			page = await once(key, async () => (settings.get().fastPages && (await fetchFast(url))) || fetchPage(url, key, signal));
		return page;
	}

	// Warm the cache without holding a window. Shares the in-flight fetch with a later readOne.
	function prefetch(url) {
		if (settings.get().fastPages && !cached(`page:${url}`)) fetchFast(url).catch(() => {});
	}

	// ---- fast path: fetch + DOMParser in one blank window that never navigates ----
	let parser = null;
	let parserReady = null;
	const parse = async (html) => {
		if (!parser || parser.isDestroyed()) {
			parser = new BrowserWindow({ show: false, webPreferences: { sandbox: true, images: false, spellcheck: false, backgroundThrottling: false } });
			parserReady = parser.loadURL("about:blank");
		}
		const w = parser;
		await parserReady;
		return w.webContents.executeJavaScript(
			`${EXTRACT_FN}(new DOMParser().parseFromString(${JSON.stringify(html.slice(0, MAX_HTML))}, "text/html"))`,
			true,
		);
	};
	const needsWindow = new Map(); // host -> until; hosts whose pages only render in a browser

	// No caller signal: a prefetch and a read may share this, and it is bounded by its own timeout.
	function fetchFast(url) {
		const key = `page:${url}`;
		return once(`fast:${url}`, async () => {
			let host = "";
			try {
				host = new URL(url).hostname;
			} catch {
				return null;
			}
			if ((needsWindow.get(host) ?? 0) > Date.now()) return null;
			try {
				const res = await ses.fetch(url, {
					headers: { accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5", "accept-language": "en" },
					signal: AbortSignal.timeout(FETCH_TIMEOUT),
				});
				const type = res.headers.get("content-type") ?? "";
				if (!res.ok || +(res.headers.get("content-length") ?? 0) > MAX_HTML) return null;
				let page;
				let heavy = false; // lots of markup, little text: a script-rendered site
				if (/html|xml/i.test(type)) {
					const html = await res.text();
					const r = await parse(html);
					heavy = html.length > 50_000;
					page = { url: res.url || url, title: r.title || url, desc: r.desc, text: r.text.replace(/\n{3,}/g, "\n\n") };
				} else if (/^text\/|json/i.test(type)) {
					page = { url: res.url || url, title: url, desc: "", text: (await res.text()).slice(0, MAX_HTML) };
				} else return null; // PDFs and the like: let the browser handle them
				if (page.text.length < 300) {
					if (heavy) needsWindow.set(host, Date.now() + TTL);
					return null;
				}
				remember(key, page);
				return page;
			} catch {
				return null;
			}
		});
	}

	async function fetchPage(url, key, signal) {
		const w = await acquire();
		try {
			await load(w, url, signal);
			let r = await w.webContents.executeJavaScript(EXTRACT, true);
			if (r.text.length < 300 && !signal?.aborted) {
				await sleep(1200); // client-rendered page: give it a moment
				r = await w.webContents.executeJavaScript(EXTRACT, true);
			}
			const page = { url: w.webContents.getURL() || url, title: r.title || url, desc: r.desc, text: r.text.replace(/\n{3,}/g, "\n\n") };
			if (page.text.length > 200) remember(key, page);
			return page;
		} finally {
			w.webContents.stop();
			release(w);
		}
	}

	function search(q, engine, signal) {
		return once(`serp:${engine}:${q}`, () => runSearch(q, engine, signal));
	}

	async function runSearch(q, engine, signal) {
		// engines that blocked us recently go last, so a CAPTCHA costs one search, not every search
		const order = [engine, ...["google", "bing", "duckduckgo"].filter((e) => e !== engine)].sort(
			(a, b) => Number((blocked.get(a) ?? 0) > Date.now()) - Number((blocked.get(b) ?? 0) > Date.now()),
		);
		let last = { results: [], answer: "", engine };
		for (const e of order) {
			const key = `serp:${e}:${q}`;
			const hit = cached(key);
			if (hit) return hit;
			const w = await acquire();
			try {
				await load(w, SERP[e].url(q), signal, { grace: 1200 });
				const r = await w.webContents.executeJavaScript(SERP[e].js, true);
				last = { ...r, engine: e };
				if (r.blocked) blocked.set(e, Date.now() + 10 * 60 * 1000);
				else if (r.results.length) {
					remember(key, last);
					return last;
				}
			} catch (err) {
				if (signal?.aborted) throw err;
			} finally {
				release(w);
			}
		}
		return last;
	}

	const text = (t, details = {}) => ({ content: [{ type: "text", text: t }], details });

	const searchTool = {
		name: "search",
		label: "Search",
		description:
			"Web search. Returns the top results (title, URL, snippet) as text in about a second, plus the engine's direct answer if it shows one. " +
			"Pass several queries at once to cover different angles; they run in parallel.",
		promptSnippet: "search: fast web search; returns titles, URLs and snippets (no screenshots)",
		parameters: Type.Object({
			queries: Type.Array(Type.String(), { description: "1-4 search queries", minItems: 1, maxItems: 4 }),
		}),
		async execute(_id, p, signal) {
			const engine = settings.get().searchEngine;
			const runs = dedupeSearchRuns(
				await Promise.all(p.queries.slice(0, 4).map((q) => search(q, engine, signal).then((r) => ({ q, ...r })))),
			);
			const lines = [];
			const urls = [];
			for (const r of runs) {
				lines.push(`## ${r.q}  (${r.engine})`);
				if (r.answer) lines.push(`Direct answer: ${r.answer}`);
				if (!r.results.length) lines.push(r.blocked ? "The engine blocked this search." : "No results.");
				r.results.slice(0, 8).forEach((x, i) => {
					lines.push(`${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`);
					urls.push(x.url);
				});
			}
			// start on the likely reads now: each query's best hits first, then the rest
			const ranked = [];
			for (let i = 0; i < 8; i++) for (const r of runs) if (r.results[i]) ranked.push(r.results[i].url);
			for (const u of [...new Set(ranked)].slice(0, PREFETCH)) prefetch(u);
			return text(lines.join("\n"), { urls });
		},
	};

	const readTool = {
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
		async execute(_id, p, signal) {
			const urls = [...new Set(p.urls.slice(0, 8).map((u) => (/^[a-z]+:\/\//i.test(u) ? u : `https://${u}`)))];
			const budget = Math.max(3000, Math.floor((PAGE_CHARS * 5) / Math.max(5, urls.length)) + (urls.length <= 2 ? 6000 : 0));
			const pages = await Promise.all(
				urls.map((u) =>
					readOne(u, signal).then(
						(pg) => ({ ok: true, ...pg }),
						(err) => ({ ok: false, url: u, error: String(err?.message ?? err) }),
					),
				),
			);
			if (signal?.aborted) throw new Error("aborted");
			const out = pages.map((pg, i) => {
				if (!pg.ok) return `[${i + 1}] ${pg.url}\nCould not load: ${pg.error}`;
				const body = focus(pg.text || pg.desc || "", p.query, budget);
				return `[${i + 1}] ${pg.title}\n${pg.url}\n\n${body || "(no readable text; try the browser tool)"}`;
			});
			return text(out.join("\n\n---\n\n"), { urls: pages.map((pg) => pg.url) });
		},
	};

	return {
		tools: [searchTool, readTool],
		/** Read one page as clean text, trimmed to what matches `query`. */
		async read(url, query, signal) {
			const pg = await readOne(url, signal);
			return { ...pg, text: focus(pg.text || pg.desc || "", query, 14000) };
		},
		warm() {
			// one window ready ahead of time so the first search doesn't pay for window creation
			if (!all.size) idle.push(make());
		},
		clear: async () => {
			cache.clear();
			needsWindow.clear();
			await ses.clearStorageData();
			await ses.clearCache();
		},
		dispose() {
			for (const w of all) if (!w.isDestroyed()) w.destroy();
			if (parser && !parser.isDestroyed()) parser.destroy();
		},
	};
}
