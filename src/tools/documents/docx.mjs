// DOCX reading (text, headings, tables) and writing (styled reports with headings, paragraphs, bullets, tables and a
// footer). Written files are validated by parsing them back. Macros and embedded code are never executed.
import { attrs, readZip, writeZip, xmlEscape, xmlUnescape } from "./zip.mjs";

/** Blocks: [{ type: "heading", level, text } | { type: "p", text } | { type: "table", rows: string[][] }] */
export function readDocx(buf) {
	const zip = readZip(buf);
	const xml = zip.text("word/document.xml");
	if (!xml) throw new Error("not a Word document (no word/document.xml)");
	const body = /<w:body>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? "";
	const blocks = [];
	const paraText = (p) =>
		[...p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g)]
			.map((m) => (m[1] !== undefined ? xmlUnescape(m[1]) : m[0] === "<w:tab/>" ? "\t" : "\n"))
			.join("");
	for (const m of body.matchAll(/<w:tbl>([\s\S]*?)<\/w:tbl>|<w:p\b[^>]*>([\s\S]*?)<\/w:p>|<w:p\b[^>]*\/>/g)) {
		if (m[1] !== undefined) {
			const rows = [...m[1].matchAll(/<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g)].map((r) =>
				[...r[1].matchAll(/<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g)].map((c) => [...c[1].matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)].map((p) => paraText(p[1])).join("\n")),
			);
			blocks.push({ type: "table", rows });
			continue;
		}
		const p = m[2] ?? "";
		const style = attrs(/<w:pStyle\b[^>]*>/.exec(p)?.[0] ?? "")["w:val"] ?? "";
		const text = paraText(p);
		const h = /^(?:Heading|heading)(\d)$/.exec(style) ?? (style === "Title" ? [null, "0"] : null);
		if (h) blocks.push({ type: "heading", level: Number(h[1]), text });
		else if (text.trim()) blocks.push({ type: "p", text, style: style || undefined });
	}
	return { blocks, macros: zip.entries.has("word/vbaProject.bin"), text: blocks.map((b) => (b.type === "table" ? b.rows.map((r) => r.join("\t")).join("\n") : b.text)).join("\n") };
}

const run = (t, { bold = false } = {}) => `<w:r>${bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${xmlEscape(t)}</w:t></w:r>`;
const para = (t, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}${inline(t)}</w:p>`;
// **bold** spans inside report text
const inline = (t) =>
	String(t)
		.split(/(\*\*[^*]+\*\*)/)
		.filter(Boolean)
		.map((s) => (s.startsWith("**") && s.endsWith("**") ? run(s.slice(2, -2), { bold: true }) : run(s)))
		.join("");

/**
 * @param {{ title: string, subtitle?: string, footer?: string, blocks: Array<{ type: "heading"|"p"|"bullets"|"table", level?: number, text?: string, items?: string[], rows?: string[][] }> }} doc
 */
export function writeDocx(doc) {
	const parts = [para(doc.title, "Title")];
	if (doc.subtitle) parts.push(para(doc.subtitle, "Subtitle"));
	for (const b of doc.blocks ?? []) {
		if (b.type === "heading") parts.push(para(b.text, `Heading${Math.min(3, Math.max(1, b.level ?? 1))}`));
		else if (b.type === "p") parts.push(para(b.text));
		else if (b.type === "bullets") for (const it of b.items ?? []) parts.push(`<w:p><w:pPr><w:pStyle w:val="ListBullet"/></w:pPr>${inline(`• ${it}`)}</w:p>`);
		else if (b.type === "table" && b.rows?.length) {
			const cols = Math.max(...b.rows.map((r) => r.length));
			const grid = `<w:tblGrid>${Array.from({ length: cols }, () => `<w:gridCol w:w="${Math.floor(9000 / cols)}"/>`).join("")}</w:tblGrid>`;
			const rows = b.rows
				.map((r, ri) => `<w:tr>${Array.from({ length: cols }, (_, ci) => `<w:tc><w:tcPr><w:tcW w:w="${Math.floor(9000 / cols)}" w:type="dxa"/></w:tcPr><w:p>${run(r[ci] ?? "", { bold: ri === 0 })}</w:p></w:tc>`).join("")}</w:tr>`)
				.join("");
			parts.push(`<w:tbl><w:tblPr><w:tblStyle w:val="Grid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr>${grid}${rows}</w:tbl>`, "<w:p/>");
		}
	}
	const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
	const footer = doc.footer ? `<w:footerReference w:type="default" r:id="rId2"/>` : "";
	const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${NS}><w:body>${parts.join("")}<w:sectPr>${footer}<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>`;
	const style = (id, name, { size, bold, color, based = "Normal", spacing = 120 } = {}) =>
		`<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="${based}"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${spacing * 2}" w:after="${spacing}"/><w:outlineLvl w:val="${/\d/.test(id) ? Number(id.slice(-1)) - 1 : 0}"/></w:pPr><w:rPr>${bold ? "<w:b/>" : ""}${color ? `<w:color w:val="${color}"/>` : ""}<w:sz w:val="${size}"/></w:rPr></w:style>`;
	const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Segoe UI" w:hAnsi="Segoe UI" w:cs="Segoe UI"/><w:sz w:val="21"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>${style("Title", "Title", { size: 40, bold: true, color: "2A2150" })}${style("Subtitle", "Subtitle", { size: 24, color: "6F6890", spacing: 60 })}${style("Heading1", "heading 1", { size: 30, bold: true, color: "6B52D6" })}${style("Heading2", "heading 2", { size: 26, bold: true, color: "2A2150" })}${style("Heading3", "heading 3", { size: 22, bold: true, color: "2A2150" })}<w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="360"/></w:pPr></w:style><w:style w:type="table" w:styleId="Grid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:color="C9C2E8"/><w:left w:val="single" w:sz="4" w:color="C9C2E8"/><w:bottom w:val="single" w:sz="4" w:color="C9C2E8"/><w:right w:val="single" w:sz="4" w:color="C9C2E8"/><w:insideH w:val="single" w:sz="4" w:color="C9C2E8"/><w:insideV w:val="single" w:sz="4" w:color="C9C2E8"/></w:tblBorders><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>`;
	const files = [
		{
			name: "[Content_Types].xml",
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>${doc.footer ? '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' : ""}</Types>`,
		},
		{
			name: "_rels/.rels",
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
		},
		{
			name: "word/_rels/document.xml.rels",
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${doc.footer ? '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>' : ""}</Relationships>`,
		},
		{ name: "word/document.xml", data: document },
		{ name: "word/styles.xml", data: styles },
	];
	if (doc.footer) files.push({ name: "word/footer1.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:ftr ${NS}>${para(doc.footer)}</w:ftr>` });
	return writeZip(files);
}

/** Parse a written report back and compare it with what was asked for. */
export function validateDocx(buf, doc) {
	const issues = [];
	let parsed;
	try {
		parsed = readDocx(buf);
	} catch (err) {
		return { ok: false, issues: [`does not open: ${err.message}`] };
	}
	const wantHeadings = (doc.blocks ?? []).filter((b) => b.type === "heading").map((b) => b.text);
	const gotHeadings = parsed.blocks.filter((b) => b.type === "heading" && b.level > 0).map((b) => b.text);
	if (wantHeadings.join("\n") !== gotHeadings.join("\n")) issues.push("headings changed when written");
	const wantTables = (doc.blocks ?? []).filter((b) => b.type === "table" && b.rows?.length);
	const gotTables = parsed.blocks.filter((b) => b.type === "table");
	if (wantTables.length !== gotTables.length) issues.push(`expected ${wantTables.length} tables, found ${gotTables.length}`);
	wantTables.forEach((t, i) => {
		const g = gotTables[i];
		if (g && JSON.stringify(t.rows.map((r) => r.map(String))) !== JSON.stringify(g.rows.map((r) => r.slice(0, t.rows[0].length)))) issues.push(`table ${i + 1} content differs`);
	});
	return { ok: issues.length === 0, issues, facts: { headings: gotHeadings.length, tables: gotTables.length, chars: parsed.text.length } };
}
