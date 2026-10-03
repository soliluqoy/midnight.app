// Text helpers shared by the shell's web worker and the headless one. No Electron here: the headless path (evals,
// tests) parses HTML with plain string work, which is good enough for article text and server-rendered result pages.

// Keep the passages that match the query, in page order, within the budget.
export function focus(text, query, budget) {
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

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", reg: "®", trade: "™", middot: "·", bull: "•" };
export function decodeEntities(s) {
	return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
		if (e[0] === "#") {
			const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
			return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
		}
		return NAMED[e.toLowerCase()] ?? m;
	});
}

const INLINE_TAGS = /<\/?(?:a|b|i|u|s|q|em|strong|code|span|small|sup|sub|abbr|mark|cite|kbd|var|time|font|tt|dfn|ins|del|big|nobr|bdi|bdo)\b[^>]*>/gi;
const inline = (s) => decodeEntities(s.replace(INLINE_TAGS, "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
const DROP = /<(script|style|noscript|svg|canvas|iframe|template|form|button|select|textarea|nav|header|footer|aside|dialog)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const textLength = (html) => inline(html).length;

// Main-content extraction without a DOM: drop chrome, prefer <article>/<main> when they hold the text, emit the same
// light markdown as the in-page extractor (headings, paragraphs, list items, table rows, code).
export function htmlToText(html) {
	const title = inline(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "");
	const desc = decodeEntities(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]*content=["']([^"']*)["']/i.exec(html)?.[1] ?? /<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["'](?:description|og:description)["']/i.exec(html)?.[1] ?? "");
	let body = (/<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html).replace(/<!--[\s\S]*?-->/g, "");
	let prev;
	do {
		prev = body;
		body = body.replace(DROP, " ");
	} while (body !== prev);
	let root = body;
	let best = 0;
	for (const m of body.matchAll(/<(article|main)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)) {
		const n = textLength(m[2]);
		if (n > best) {
			best = n;
			root = m[2];
		}
	}
	if (best < 400) root = body;
	const out = [];
	root
		.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_, c) => `\u0000PRE${Buffer.from(decodeEntities(c.replace(/<[^>]*>/g, "")).trim().slice(0, 3000)).toString("base64")}\u0000`)
		.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_, n, c) => `\u0000H${n}${inline(c)}\u0000`)
		.replace(/<li\b[^>]*>/gi, "\u0000LI")
		.replace(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi, (_, row) => {
			const cells = [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]\s*>/gi)].map((c) => inline(c[1]));
			return cells.some(Boolean) ? `\u0000TR| ${cells.join(" | ")} |\u0000` : " ";
		})
		.replace(/<\/?(p|div|section|article|main|blockquote|dd|dt|figcaption|br|hr|ul|ol|table|li)\b[^>]*>/gi, "\u0000")
		.split("\u0000")
		.forEach((chunk) => {
			if (chunk.startsWith("PRE")) return out.push(`\`\`\`\n${Buffer.from(chunk.slice(3), "base64").toString()}\n\`\`\``);
			if (/^H[1-6]/.test(chunk)) return chunk.length > 2 && out.push(`${"#".repeat(+chunk[1])} ${chunk.slice(2)}`);
			if (chunk.startsWith("TR")) return out.push(chunk.slice(2));
			const li = chunk.startsWith("LI");
			const s = inline(li ? chunk.slice(2) : chunk);
			if (s) out.push(li ? `- ${s}` : s);
		});
	return { title, desc, text: out.join("\n\n").replace(/\n{3,}/g, "\n\n") };
}

const attr = (tag, name) => decodeEntities(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag)?.slice(1).find((x) => x !== undefined) ?? "");

// Result pages that render on the server, so a plain fetch sees the results.
export const SERP_URL = {
	duckduckgo: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
	bing: (q) => `https://www.bing.com/search?setlang=en&q=${encodeURIComponent(q)}`,
};

export function parseSerp(engine, html) {
	const results = [];
	if (engine === "duckduckgo") {
		const blocked = /anomaly-modal|class="anomaly/.test(html);
		const anchors = [...html.matchAll(/<a\b([^>]*class=["'][^"']*\bresult__a\b[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi)];
		anchors.forEach((m, i) => {
			let href = attr(m[1], "href");
			try {
				const u = new URL(href, "https://duckduckgo.com");
				href = u.searchParams.get("uddg") ?? u.href;
			} catch {}
			if (/duckduckgo\.com\/y\.js/.test(href) || !/^https?:/.test(href)) return;
			const span = html.slice(m.index, anchors[i + 1]?.index ?? m.index + 4000);
			const sn = /class=["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div|td)>/i.exec(span);
			results.push({ title: inline(m[2]), url: href, snippet: sn ? inline(sn[1]).slice(0, 320) : "" });
		});
		return { results, answer: "", blocked };
	}
	if (engine === "bing") {
		const items = html.split(/<li\b[^>]*class=["'][^"']*\bb_algo\b/i).slice(1);
		for (const it of items) {
			const a = /<h2\b[^>]*>[\s\S]*?<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(it);
			if (!a) continue;
			let href = attr(a[1], "href");
			try {
				const u = new URL(href);
				const enc = u.searchParams.get("u");
				if (u.host.endsWith("bing.com") && enc?.startsWith("a1")) href = Buffer.from(enc.slice(2).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString();
			} catch {}
			if (!/^https?:/.test(href)) continue;
			const sn = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(it);
			results.push({ title: inline(a[2]), url: href, snippet: sn ? inline(sn[1]).slice(0, 320) : "" });
		}
		return { results, answer: "", blocked: /captcha|\/challenge/i.test(html) && !results.length };
	}
	throw new Error(`no headless parser for ${engine}`);
}
