// RFC 4180 CSV with quoted fields, embedded newlines and a sniffed delimiter (comma, semicolon or tab).
export function parseCsv(text, { delimiter } = {}) {
	const src = String(text).replace(/^﻿/, "");
	const d = delimiter ?? sniff(src);
	const rows = [];
	let row = [];
	let field = "";
	let q = false;
	for (let i = 0; i < src.length; i++) {
		const c = src[i];
		if (q) {
			if (c === '"') {
				if (src[i + 1] === '"') {
					field += '"';
					i++;
				} else q = false;
			} else field += c;
		} else if (c === '"' && field === "") q = true;
		else if (c === d) {
			row.push(field);
			field = "";
		} else if (c === "\n" || c === "\r") {
			if (c === "\r" && src[i + 1] === "\n") i++;
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
		} else field += c;
	}
	if (field !== "" || row.length) {
		row.push(field);
		rows.push(row);
	}
	return rows;
}

function sniff(src) {
	const first = src.split(/\r?\n/, 1)[0] ?? "";
	const counts = [",", ";", "\t"].map((d) => [d, first.split(d).length]);
	counts.sort((a, b) => b[1] - a[1]);
	return counts[0][1] > 1 ? counts[0][0] : ",";
}

export function toCsv(rows) {
	return `${rows.map((r) => r.map((v) => (v === null || v === undefined ? "" : /[",\n\r]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))).join(",")).join("\r\n")}\r\n`;
}

/** Numbers as people write them: "1,287", "$412k", "(30)", "10.4%". Returns { value, unit } or undefined. */
export function parseNumber(s) {
	if (typeof s === "number") return { value: s, unit: "" };
	let t = String(s ?? "").trim();
	if (!t) return undefined;
	let neg = false;
	if (/^\(.*\)$/.test(t)) {
		neg = true;
		t = t.slice(1, -1);
	}
	const unit = (t.match(/[%kKmM]$|^[$€£]/g) ?? []).join("");
	t = t.replace(/[$€£%\s]/g, "").replace(/,(?=\d{3}\b)/g, "");
	let mult = 1;
	if (/[kK]$/.test(t)) {
		mult = 1e3;
		t = t.slice(0, -1);
	} else if (/[mM]$/.test(t)) {
		mult = 1e6;
		t = t.slice(0, -1);
	}
	if (!/^[-+]?\d*\.?\d+(e[-+]?\d+)?$/i.test(t)) return undefined;
	const v = Number(t) * mult;
	return { value: neg ? -v : v, unit };
}
