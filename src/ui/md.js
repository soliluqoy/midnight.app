// Small, safe Markdown renderer for answers: everything is escaped first, only http(s) links survive.
// Handles headings, lists, tables, code, quotes, bold/italic, links and [n] citations tied to the Sources list.
window.md = (() => {
	const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
	const esc = (s) => s.replace(/[&<>"']/g, (c) => ESC[c]);

	// "1. [Title](https://…)" or "[1] Title — https://…" -> {1: url}
	function refs(text) {
		const out = {};
		for (const line of text.split("\n")) {
			const m = line.match(/^\s*(?:[-*]\s*)?\[?(\d{1,2})\]?[.):]?\s+(.*)$/);
			if (!m) continue;
			const u = m[2].match(/\((https?:\/\/[^\s)]+)\)/) ?? m[2].match(/(https?:\/\/[^\s<>]+)/);
			if (u) out[m[1]] = u[1].replace(/[).,;]+$/, "");
		}
		return out;
	}

	function inline(s, r) {
		const codes = [];
		s = s.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
		s = esc(s);
		s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => `<a href="${u}" title="${u}">${t}</a>`);
		s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]*[^\s<.,;:)\]])/g, (_, pre, u) => `${pre}<a href="${u}" title="${u}">${u.replace(/^https?:\/\/(www\.)?/, "").slice(0, 48)}</a>`);
		s = s.replace(/\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\](?!\()/g, (_, list) =>
			list
				.split(/\s*,\s*/)
				.map((n) => (r[n] ? `<a class="cite" href="${esc(r[n])}" title="${esc(r[n])}">${n}</a>` : `<sup class="cite">${n}</sup>`))
				.join(""),
		);
		s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
		s = s.replace(/(^|[^*\w])\*(?!\s)([^*]+?)\*(?!\w)/g, "$1<em>$2</em>");
		s = s.replace(/~~(.+?)~~/g, "<del>$1</del>");
		return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`);
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
			if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li${i.sub ? ' class="sub"' : ""}>${inline(i.t, r)}</li>`).join("")}</${list.tag}>`);
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
					list = { tag, items: [] };
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
