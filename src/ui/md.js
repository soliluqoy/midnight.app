// Small, safe Markdown renderer for answers: everything is escaped first, only http(s) links survive.
// Handles headings, lists, tables, code, quotes, bold/italic, links and [n] citations tied to the Sources list.
window.md = (() => {
	const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
	const esc = (s) => s.replace(/[&<>"']/g, (c) => ESC[c]);
	const trimUrl = (s) => {
		s = s.replace(/[.,;]+$/, "");
		for (const [open, close] of [["(", ")"], ["[", "]"]]) {
			while (s.endsWith(close) && s.split(close).length > s.split(open).length) s = s.slice(0, -1);
		}
		return s;
	};
	function links(s, replace) {
		const pattern = /\[([^\]]+)\]\((https?:\/\/)/g;
		let out = "", cursor = 0, match;
		while ((match = pattern.exec(s))) {
			const start = match.index + match[1].length + 3;
			let depth = 0;
			let end = start;
			for (; end < s.length; end++) {
				if (/\s/.test(s[end])) break;
				if (s[end] === "(") depth++;
				if (s[end] === ")" && depth-- === 0) break;
			}
			if (s[end] !== ")") continue;
			out += s.slice(cursor, match.index) + replace(match[1], s.slice(start, end));
			cursor = end + 1;
			pattern.lastIndex = cursor;
		}
		return out + s.slice(cursor);
	}

	// "1. [Title](https://…)" or "[1] Title — https://…" -> {1: url}
	function refs(text) {
		const out = {};
		let fence;
		for (const line of text.split("\n")) {
			const f = line.match(/^\s*(`{3,}|~{3,})/);
			if (f) {
				if (!fence) fence = f[1][0];
				else if (f[1][0] === fence) fence = undefined;
				continue;
			}
			if (fence) continue;
			const m = line.match(/^\s*(?:[-*]\s*)?\[?(\d{1,2})\]?[.):]?\s+(.*)$/);
			if (!m) continue;
			let url;
			const content = m[2].replace(/`[^`]*`/g, "");
			links(content, (_label, u) => { url ??= u; return ""; });
			url ??= content.match(/https?:\/\/[^\s<>]+/)?.[0];
			if (url) out[m[1]] = trimUrl(url);
		}
		return out;
	}

	function inline(s, r) {
		const tokens = [];
		const protect = (html) => `\u0000${tokens.push(html) - 1}\u0000`;
		const restore = (text) => text.replace(/\u0000(\d+)\u0000/g, (_, i) => tokens[+i]);
		const format = (text) => text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*\w])\*(?!\s)([^*]+?)\*(?!\w)/g, "$1<em>$2</em>").replace(/~~(.+?)~~/g, "<del>$1</del>");
		s = s.replace(/\u0000/g, "\ufffd");
		s = s.replace(/`([^`]+)`/g, (_, c) => protect(`<code>${esc(c)}</code>`));
		s = links(s, (label, url) => protect(`<a href="${esc(url)}" title="${esc(url)}">${restore(format(esc(label)))}</a>`));
		s = s.replace(/(^|[\s(])(https?:\/\/[^\s<>\u0000]+)/g, (_, pre, raw) => {
			const url = trimUrl(raw);
			return pre + protect(`<a href="${esc(url)}" title="${esc(url)}">${esc(url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 48))}</a>`) + raw.slice(url.length);
		});
		s = esc(s);
		s = s.replace(/\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\](?!\()/g, (_, list) =>
			list
				.split(/\s*,\s*/)
				.map((n) => protect(r[n] ? `<a class="cite" href="${esc(r[n])}" title="${esc(r[n])}">${n}</a>` : `<sup class="cite">${n}</sup>`))
				.join(""),
		);
		return restore(format(s));
	}

	const cells = (line) =>
		line
			.trim()
			.replace(/^\|/, "")
			.replace(/\|$/, "")
			.split("|")
			.map((c) => c.trim());

	function render(text) {
		const r = refs(text);
		const lines = text.replace(/\r/g, "").split("\n");
		const out = [];
		let para = [];
		let list = null; // {tag, items}
		const flushPara = () => {
			if (para.length) out.push(`<p>${para.map((l) => inline(l, r)).join("<br>")}</p>`);
			para = [];
		};
		const flushList = () => {
			if (list) out.push(`<${list.tag}${list.tag === "ol" && list.start !== 1 ? ` start="${list.start}"` : ""}>${list.items.map((i) => `<li${i.sub ? ' class="sub"' : ""}>${inline(i.t, r)}</li>`).join("")}</${list.tag}>`);
			list = null;
		};
		const flush = () => {
			flushPara();
			flushList();
		};

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			let m;
			if ((m = line.match(/^\s*```(\S*)/))) {
				flush();
				const code = [];
				while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i]);
				out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
			} else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
				flush();
				const lvl = Math.min(5, Math.max(3, m[1].length + 1));
				out.push(`<h${lvl}>${inline(m[2].replace(/\s#+$/, ""), r)}</h${lvl}>`);
			} else if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1] ?? "") && (lines[i + 1] ?? "").includes("-")) {
				flush();
				const head = cells(line);
				i++;
				const rows = [];
				while (i + 1 < lines.length && /^\s*\|/.test(lines[i + 1])) rows.push(cells(lines[++i]));
				out.push(
					`<div class="tbl"><table><thead><tr>${head.map((c) => `<th>${inline(c, r)}</th>`).join("")}</tr></thead><tbody>${rows
						.map((row) => `<tr>${row.map((c) => `<td>${inline(c, r)}</td>`).join("")}</tr>`)
						.join("")}</tbody></table></div>`,
				);
			} else if ((m = line.match(/^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/))) {
				flushPara();
				const tag = /\d/.test(m[2]) ? "ol" : "ul";
				const sub = m[1].length >= 2;
				if (!list || (list.tag !== tag && !sub)) {
					flushList();
					list = { tag, start: tag === "ol" ? parseInt(m[2], 10) : 1, items: [] };
				}
				list.items.push({ t: m[3], sub });
			} else if ((m = line.match(/^\s*>\s?(.*)$/))) {
				flush();
				out.push(`<blockquote>${inline(m[1], r)}</blockquote>`);
			} else if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
				flush();
				out.push("<hr>");
			} else if (!line.trim()) {
				flush();
			} else if (list && /^\s{2,}\S/.test(line)) {
				list.items[list.items.length - 1].t += ` ${line.trim()}`;
			} else {
				flushList();
				para.push(line);
			}
		}
		flush();
		return out.join("");
	}

	return { render, refs };
})();
