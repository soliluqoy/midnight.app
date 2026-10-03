// XLSX reading, surgical cell updates and simple workbook writing (plan ch. 11, T02). Values come from the
// workbook's cached results; formulas are reported with their text and never recomputed by guesswork. Edits
// change only the target sheet's cells and leave every other part (styles, names, other sheets) byte-identical.
import { attrs, readZip, writeZip, xmlEscape, xmlUnescape } from "./zip.mjs";

export const colIndex = (letters) => [...letters.toUpperCase()].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
export const colLetters = (n) => {
	let s = "";
	for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
	return s;
};
export const splitRef = (ref) => {
	const m = /^([A-Z]+)(\d+)$/i.exec(ref);
	return m ? { col: colIndex(m[1]), row: Number(m[2]) } : undefined;
};

function relTarget(base, target) {
	if (target.startsWith("/")) return target.slice(1);
	const parts = base.split("/").slice(0, -1);
	for (const seg of target.split("/")) {
		if (seg === "..") parts.pop();
		else if (seg !== ".") parts.push(seg);
	}
	return parts.join("/");
}

/** Read a workbook into { sheets: [{ name, hidden, path, cells: Map(ref -> {v, t, f}), hiddenRows: Set, maxRow, maxCol }], names }. */
export function readXlsx(buf) {
	const zip = readZip(buf);
	const wb = zip.text("xl/workbook.xml");
	if (!wb) throw new Error("not an Excel workbook (no xl/workbook.xml)");
	if (zip.entries.has("xl/vbaProject.bin")) {
		// Macros are never executed; we only read cell data. Noted so the caller can tell the user.
	}
	const rels = new Map();
	for (const m of (zip.text("xl/_rels/workbook.xml.rels") ?? "").matchAll(/<Relationship\b[^>]*>/g)) {
		const a = attrs(m[0]);
		rels.set(a.Id, relTarget("xl/workbook.xml", a.Target));
	}
	const shared = [];
	for (const m of (zip.text("xl/sharedStrings.xml") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)) {
		shared.push([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => xmlUnescape(t[1])).join(""));
	}
	const names = {};
	for (const m of wb.matchAll(/<definedName\b([^>]*)>([\s\S]*?)<\/definedName>/g)) names[attrs(m[1]).name] = xmlUnescape(m[2]);
	const sheets = [];
	for (const m of wb.matchAll(/<sheet\b[^>]*\/?>/g)) {
		const a = attrs(m[0]);
		const p = rels.get(a["r:id"]);
		const xml = p ? zip.text(p) : undefined;
		if (!xml) continue;
		const cells = new Map();
		const hiddenRows = new Set();
		let maxRow = 0;
		let maxCol = 0;
		for (const r of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g)) {
			const ra = attrs(r[1] ?? r[3] ?? "");
			if (ra.hidden === "1" || ra.hidden === "true") hiddenRows.add(Number(ra.r));
			for (const c of (r[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
				const ca = attrs(c[1]);
				const inner = c[2] ?? "";
				const f = /<f\b[^>]*>([\s\S]*?)<\/f>/.exec(inner)?.[1];
				const fShared = /<f\b[^>]*\/>/.test(inner);
				const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
				let value;
				if (ca.t === "s") value = shared[Number(v)] ?? "";
				else if (ca.t === "inlineStr") value = [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => xmlUnescape(t[1])).join("");
				else if (ca.t === "str") value = v !== undefined ? xmlUnescape(v) : undefined;
				else if (ca.t === "b") value = v === "1";
				else if (ca.t === "e") value = v !== undefined ? { error: xmlUnescape(v) } : undefined;
				else value = v !== undefined ? Number(v) : undefined;
				const pos = splitRef(ca.r);
				if (!pos) continue;
				maxRow = Math.max(maxRow, pos.row);
				maxCol = Math.max(maxCol, pos.col);
				cells.set(ca.r, { v: value, t: ca.t ?? "n", f: f !== undefined ? xmlUnescape(f) : fShared ? "(shared formula)" : undefined });
			}
		}
		sheets.push({ name: a.name, hidden: a.state === "hidden" || a.state === "veryHidden", path: p, cells, hiddenRows, maxRow, maxCol });
	}
	return { sheets, names, macros: zip.entries.has("xl/vbaProject.bin") };
}

/** Rows of a range (default: used range) as arrays, with refs. */
export function sheetRange(sheet, range) {
	let c1 = 1;
	let r1 = 1;
	let c2 = sheet.maxCol;
	let r2 = sheet.maxRow;
	if (range) {
		const [a, b] = range.toUpperCase().split(":");
		const A = splitRef(a);
		const B = splitRef(b ?? a);
		if (!A || !B) throw new Error(`bad range ${range}`);
		[c1, r1, c2, r2] = [Math.min(A.col, B.col), Math.min(A.row, B.row), Math.max(A.col, B.col), Math.max(A.row, B.row)];
	}
	const rows = [];
	for (let r = r1; r <= r2; r++) {
		const row = [];
		for (let c = c1; c <= c2; c++) {
			const ref = `${colLetters(c)}${r}`;
			row.push({ ref, ...(sheet.cells.get(ref) ?? { v: undefined }) });
		}
		rows.push({ row: r, hidden: sheet.hiddenRows.has(r), cells: row });
	}
	return { range: `${colLetters(c1)}${r1}:${colLetters(c2)}${r2}`, rows };
}

/** Write a simple workbook: [{ name, rows: [[value | { v, f }]] }]. Numbers stay numbers; formulas keep cached values. */
export function writeXlsx(sheets) {
	const files = [];
	const sheetXml = (rows) => {
		const body = rows
			.map((row, ri) => {
				const cells = row
					.map((cell, ci) => {
						if (cell === null || cell === undefined || cell === "") return "";
						const ref = `${colLetters(ci + 1)}${ri + 1}`;
						const v = typeof cell === "object" && !Array.isArray(cell) ? cell : { v: cell };
						const f = v.f ? `<f>${xmlEscape(v.f)}</f>` : "";
						if (typeof v.v === "number") return `<c r="${ref}">${f}<v>${v.v}</v></c>`;
						if (typeof v.v === "boolean") return `<c r="${ref}" t="b">${f}<v>${v.v ? 1 : 0}</v></c>`;
						return `<c r="${ref}" t="inlineStr">${f}<is><t xml:space="preserve">${xmlEscape(v.v ?? "")}</t></is></c>`;
					})
					.join("");
				return `<row r="${ri + 1}">${cells}</row>`;
			})
			.join("");
		return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
	};
	sheets.forEach((s, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s.rows) }));
	files.unshift(
		{
			name: "[Content_Types].xml",
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets
				.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
				.join("")}</Types>`,
		},
		{
			name: "_rels/.rels",
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
		},
		{
			name: "xl/workbook.xml",
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
				.map((s, i) => `<sheet name="${xmlEscape(s.name)}" sheetId="${i + 1}"${s.hidden ? ' state="hidden"' : ""} r:id="rId${i + 1}"/>`)
				.join("")}</sheets></workbook>`,
		},
		{
			name: "xl/_rels/workbook.xml.rels",
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
				.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
				.join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
		},
		{
			name: "xl/styles.xml",
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`,
		},
	);
	return writeZip(files);
}

/**
 * Change cell values in one sheet; every other part of the package is copied unchanged. Formulas in edited cells are
 * replaced by the new value; the workbook is flagged to recalculate on open so dependent formulas are not stale.
 * Returns { buffer, changed: [refs] }.
 */
export function updateCells(buf, sheetName, values) {
	const zip = readZip(buf);
	const book = readXlsx(buf);
	const sheet = book.sheets.find((s) => s.name === sheetName);
	if (!sheet) throw new Error(`no sheet named ${sheetName}`);
	let xml = zip.text(sheet.path);
	const changed = [];
	for (const [ref, value] of Object.entries(values)) {
		const R = ref.toUpperCase();
		const cell = typeof value === "number" ? `<c r="${R}"><v>${value}</v></c>` : `<c r="${R}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
		const re = new RegExp(`<c r="${R}"(?:\\s[^>]*)?(?:/>|>[\\s\\S]*?</c>)`);
		if (re.test(xml)) xml = xml.replace(re, cell.replace(/^<c r="[A-Z]+\d+"/, (m) => m));
		else {
			const row = splitRef(R).row;
			const rowRe = new RegExp(`(<row\\b[^>]*\\br="${row}"[^>]*>)([\\s\\S]*?)(</row>)`);
			if (rowRe.test(xml)) xml = xml.replace(rowRe, (_, a, inner, b) => `${a}${insertSorted(inner, R, cell)}${b}`);
			else xml = xml.replace(/<sheetData>([\s\S]*?)<\/sheetData>|<sheetData\/>/, (m, inner = "") => `<sheetData>${insertRow(inner, row, `<row r="${row}">${cell}</row>`)}</sheetData>`);
		}
		changed.push(R);
	}
	let wb = zip.text("xl/workbook.xml");
	wb = /<calcPr\b/.test(wb) ? wb.replace(/<calcPr\b([^>]*?)\/>/, (m, a) => (/fullCalcOnLoad/.test(a) ? m : `<calcPr${a} fullCalcOnLoad="1"/>`)) : wb.replace("</workbook>", '<calcPr fullCalcOnLoad="1"/></workbook>');
	const files = [...zip.entries.keys()]
		.filter((n) => n !== "xl/calcChain.xml")
		.map((name) => ({ name, data: name === sheet.path ? xml : name === "xl/workbook.xml" ? wb : zip.read(name) }));
	return { buffer: writeZip(files), changed };
}

function insertSorted(inner, ref, cell) {
	const col = splitRef(ref).col;
	const cells = [...inner.matchAll(/<c r="([A-Z]+)\d+"/g)];
	const after = cells.find((m) => colIndex(m[1]) > col);
	return after ? inner.slice(0, after.index) + cell + inner.slice(after.index) : inner + cell;
}
function insertRow(inner, row, rowXml) {
	const rows = [...inner.matchAll(/<row\b[^>]*\br="(\d+)"/g)];
	const after = rows.find((m) => Number(m[1]) > row);
	return after ? inner.slice(0, after.index) + rowXml + inner.slice(after.index) : inner + rowXml;
}
