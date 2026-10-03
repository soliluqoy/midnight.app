// Work tools for verified artifacts (plan ch. 11, 15; T02/T03): read spreadsheet ranges with cell-level evidence,
// calculate deterministically with a recorded formula, and produce charts and reports that are validated by
// parsing them back before they count.
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { fileHash } from "../evidence/store.mjs";
import { parseCsv, parseNumber, toCsv } from "./documents/csv.mjs";
import { validateDocx, writeDocx } from "./documents/docx.mjs";
import { colLetters, readXlsx, sheetRange } from "./documents/xlsx.mjs";
import { assertInside } from "./files.mjs";

// ---------------- safe arithmetic ----------------
const FUNCS = {
	sum: (...a) => a.reduce((x, y) => x + y, 0),
	avg: (...a) => a.reduce((x, y) => x + y, 0) / a.length,
	min: Math.min,
	max: Math.max,
	abs: Math.abs,
	round: (x, d = 0) => Math.round(x * 10 ** d) / 10 ** d,
};

/** Evaluate + - * / ^ ( ) with named inputs and a few functions. No property access, no code. */
export function evaluate(expr, inputs = {}) {
	const tokens = String(expr).match(/\d+(?:\.\d+)?(?:e[-+]?\d+)?|[A-Za-z_][\w]*|[-+*/^(),]|\S/gi) ?? [];
	let i = 0;
	const peek = () => tokens[i];
	const take = (t) => {
		if (t && tokens[i] !== t) throw new Error(`expected ${t} near "${tokens.slice(i, i + 3).join(" ")}"`);
		return tokens[i++];
	};
	const primary = () => {
		const t = take();
		if (t === undefined) throw new Error("unexpected end of formula");
		if (t === "(") {
			const v = expr0();
			take(")");
			return v;
		}
		if (t === "-") return -primary();
		if (t === "+") return primary();
		if (/^\d/.test(t)) return Number(t);
		if (/^[A-Za-z_]/.test(t)) {
			if (peek() === "(") {
				const f = FUNCS[t.toLowerCase()];
				if (!f) throw new Error(`unknown function ${t}`);
				take("(");
				const args = [];
				if (peek() !== ")") {
					args.push(expr0());
					while (peek() === ",") {
						take(",");
						args.push(expr0());
					}
				}
				take(")");
				return f(...args);
			}
			if (!Object.hasOwn(inputs, t)) throw new Error(`unknown input ${t}`);
			const v = Number(inputs[t]);
			if (!Number.isFinite(v)) throw new Error(`input ${t} is not a number`);
			return v;
		}
		throw new Error(`unexpected "${t}"`);
	};
	const power = () => {
		const b = primary();
		if (peek() === "^") {
			take("^");
			return b ** power();
		}
		return b;
	};
	const term = () => {
		let v = power();
		while (peek() === "*" || peek() === "/") {
			const op = take();
			const r = power();
			if (op === "/" && r === 0) throw new Error("division by zero");
			v = op === "*" ? v * r : v / r;
		}
		return v;
	};
	const expr0 = () => {
		let v = term();
		while (peek() === "+" || peek() === "-") v = take() === "+" ? v + term() : v - term();
		return v;
	};
	const v = expr0();
	if (i < tokens.length) throw new Error(`unexpected "${tokens[i]}"`);
	return Math.round(v * 1e10) / 1e10;
}

// ---------------- charts ----------------
const PALETTE = ["#8068e8", "#ff9fc7", "#5fb39a", "#e0a23d", "#5c9fd9"];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmt = (v) => (Math.abs(v) >= 1000 ? v.toLocaleString("en-US", { maximumFractionDigits: 1 }) : String(Math.round(v * 100) / 100));

/** Grouped bar chart as SVG; every bar carries data-series/data-category/data-value for validation. */
export function barChartSvg({ title, categories, series, unit = "", note = "" }) {
	const W = 760;
	const H = 420;
	const L = 64;
	const R = 24;
	const T = 64;
	const B = 72;
	const max = Math.max(0, ...series.flatMap((s) => s.values));
	const min = Math.min(0, ...series.flatMap((s) => s.values));
	const span = max - min || 1;
	const step = 10 ** Math.floor(Math.log10(span / 4 || 1));
	const tick = [1, 2, 2.5, 5, 10].map((m) => m * step).find((t) => span / t <= 6) ?? step * 10;
	const top = Math.ceil(max / tick) * tick || tick;
	const bottom = Math.floor(min / tick) * tick;
	const y = (v) => T + ((top - v) / (top - bottom)) * (H - T - B);
	const groupW = (W - L - R) / categories.length;
	const barW = Math.min(36, (groupW * 0.7) / series.length);
	const parts = [];
	parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="Segoe UI, sans-serif" role="img" aria-label="${esc(title)}">`);
	parts.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`, `<text x="${L}" y="34" font-size="18" font-weight="600" fill="#1f1a3a">${esc(title)}</text>`);
	for (let v = bottom; v <= top + 1e-9; v += tick) {
		parts.push(`<line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="#e6e2f3"/>`, `<text x="${L - 8}" y="${(y(v) + 4).toFixed(1)}" font-size="11" text-anchor="end" fill="#6f6890">${fmt(v)}${unit}</text>`);
	}
	categories.forEach((c, ci) => {
		const gx = L + ci * groupW + (groupW - barW * series.length) / 2;
		series.forEach((s, si) => {
			const v = s.values[ci];
			const y0 = y(Math.max(0, v));
			const h = Math.abs(y(v) - y(0));
			parts.push(
				`<rect class="bar" x="${(gx + si * barW).toFixed(1)}" y="${y0.toFixed(1)}" width="${(barW - 3).toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="${PALETTE[si % PALETTE.length]}" data-series="${esc(s.name)}" data-category="${esc(c)}" data-value="${v}"><title>${esc(`${s.name} · ${c}: ${fmt(v)}${unit}`)}</title></rect>`,
			);
		});
		parts.push(`<text class="cat" x="${(L + ci * groupW + groupW / 2).toFixed(1)}" y="${H - B + 20}" font-size="12" text-anchor="middle" fill="#2a2150">${esc(c)}</text>`);
	});
	series.forEach((s, si) => parts.push(`<rect x="${L + si * 140}" y="${H - 30}" width="12" height="12" rx="2" fill="${PALETTE[si % PALETTE.length]}"/><text class="legend" x="${L + si * 140 + 18}" y="${H - 20}" font-size="12" fill="#2a2150">${esc(s.name)}</text>`));
	if (note) parts.push(`<text x="${W - R}" y="${H - 20}" font-size="10" text-anchor="end" fill="#8b86aa">${esc(note)}</text>`);
	parts.push("</svg>");
	return parts.join("\n");
}

export function validateChartSvg(svg, { categories, series }) {
	const issues = [];
	const bars = [...svg.matchAll(/data-series="([^"]*)" data-category="([^"]*)" data-value="([^"]*)"/g)].map((m) => ({ s: m[1], c: m[2], v: Number(m[3]) }));
	if (bars.length !== categories.length * series.length) issues.push(`expected ${categories.length * series.length} bars, found ${bars.length}`);
	series.forEach((s) =>
		categories.forEach((c, ci) => {
			const b = bars.find((x) => x.s === esc(s.name) && x.c === esc(c));
			if (!b || b.v !== s.values[ci]) issues.push(`${s.name}/${c} should be ${s.values[ci]}`);
		}),
	);
	for (const c of categories) if (!svg.includes(`>${esc(c)}</text>`)) issues.push(`missing label ${c}`);
	const totals = Object.fromEntries(series.map((s) => [s.name, Math.round(s.values.reduce((a, b) => a + b, 0) * 1e6) / 1e6]));
	return { ok: issues.length === 0, issues, facts: { bars: bars.length, totals } };
}

// ---------------- tools ----------------
export function workTools({ roots, evidence, commit }) {
	const sheetRead = {
		name: "sheet_read",
		label: "Read spreadsheet",
		description:
			"Read a range from an .xlsx or .csv file in a selected folder. Returns values with cell references, marks hidden rows and formulas (the workbook's cached result is shown; Midnight does not recompute formulas). Records evidence for each read.",
		parameters: Type.Object({
			path: Type.String(),
			sheet: Type.Optional(Type.String()),
			range: Type.Optional(Type.String({ description: "e.g. A1:D20; default the used range (first 200 rows)" })),
		}),
		classify: (a) => ({ effect: "read.local", paths: [a.path], target: `${path.basename(a.path)}${a.sheet ? ` › ${a.sheet}` : ""}${a.range ? `!${a.range}` : ""}`, canonical: { path: path.resolve(a.path), sheet: a.sheet ?? "", range: a.range ?? "" }, feed: `sheet › ${path.basename(a.path)}${a.range ? ` ${a.range}` : ""}` }),
		async execute(a, ctx) {
			const { real } = assertInside(roots.list(), a.path, "file");
			const st = fs.statSync(real);
			if (st.size > 50 * 1024 * 1024) throw new Error("spreadsheet is larger than 50 MB");
			const buf = fs.readFileSync(real);
			const hash = fileHash(buf);
			let sheetName;
			let rows;
			let range;
			const notes = [];
			if (/\.(csv|tsv|txt)$/i.test(real)) {
				const data = parseCsv(buf.toString("utf8"));
				sheetName = path.basename(real);
				rows = data.slice(0, 200).map((r, ri) => ({ row: ri + 1, hidden: false, cells: r.map((v, ci) => ({ ref: `${colLetters(ci + 1)}${ri + 1}`, v })) }));
				range = `A1:${colLetters(Math.max(1, ...data.map((r) => r.length)))}${Math.min(200, data.length)}`;
			} else {
				const book = readXlsx(buf);
				if (book.macros) notes.push("The workbook contains macros; they were not run.");
				const sheet = a.sheet ? book.sheets.find((s) => s.name.toLowerCase() === a.sheet.toLowerCase()) : book.sheets.find((s) => !s.hidden) ?? book.sheets[0];
				if (!sheet) throw new Error(`no sheet ${a.sheet}; sheets: ${book.sheets.map((s) => s.name).join(", ")}`);
				sheetName = sheet.name;
				const r = sheetRange(sheet, a.range ?? (sheet.maxRow > 200 ? `A1:${colLetters(sheet.maxCol)}200` : undefined));
				rows = r.rows;
				range = r.range;
				if (book.sheets.length > 1) notes.push(`Other sheets: ${book.sheets.filter((s) => s !== sheet).map((s) => `${s.name}${s.hidden ? " (hidden)" : ""}`).join(", ")}.`);
			}
			const formulas = [];
			const lines = rows.map((r) => {
				const cells = r.cells.map((c) => {
					if (c.f) formulas.push(`${c.ref}: =${c.f} (cached ${c.v ?? "none"})`);
					const v = c.v === undefined ? "" : typeof c.v === "object" ? `#${c.v.error}` : String(c.v);
					return `${c.ref}=${v}`;
				});
				return `${r.hidden ? "[hidden row] " : ""}${cells.filter((x) => !x.endsWith("=")).join(" | ")}`;
			});
			const hidden = rows.filter((r) => r.hidden).length;
			if (hidden) notes.push(`${hidden} hidden row${hidden > 1 ? "s" : ""} in range; check whether they belong in totals.`);
			if (formulas.length) notes.push(`Formulas (cached values; unsupported recalculation): ${formulas.slice(0, 20).join("; ")}`);
			const units = rows[0]?.cells.map((c) => String(c.v ?? "")).filter((h) => /\((k|m|\$|%|usd|eur|000s?)\)|thousand|million/i.test(h));
			if (units?.length) notes.push(`Units in headers: ${units.join(", ")}.`);
			const evId = commit(() => evidence.record(ctx.missionId, { kind: "sheet", source: real, sourceVersion: hash, hash, locator: { sheet: sheetName, range }, excerpt: lines.slice(0, 15).join("\n") }));
			return {
				content: [{ type: "text", text: `${path.basename(real)} › ${sheetName}!${range} (evidence ${evId}, file ${hash.slice(0, 19)}…)\n${lines.join("\n")}${notes.length ? `\n\nNotes: ${notes.join(" ")}` : ""}` }],
				details: { evidenceId: evId, sheet: sheetName, range },
			};
		},
	};

	const calculate = {
		name: "calculate",
		label: "Calculate",
		description:
			"Compute a number deterministically and record it as evidence with its inputs and formula, e.g. inputs {q2: 1287, q3: 1421}, formula \"(q3 - q2) / q2 * 100\". Use for totals, differences and percentages; never do arithmetic in your head.",
		parameters: Type.Object({
			label: Type.String({ description: "what this number is, e.g. Total Q3 revenue (k$)" }),
			inputs: Type.Record(Type.String(), Type.Union([Type.Number(), Type.String()])),
			formula: Type.String({ description: "+ - * / ^ ( ) and sum avg min max round abs; names are input keys" }),
			sources: Type.Optional(Type.Array(Type.String(), { description: "evidence ids the inputs came from" })),
		}),
		classify: (a) => ({ effect: "compute", target: a.label, canonical: a, feed: `calculate › ${a.label}`, icon: "∑" }),
		async execute(a, ctx) {
			const inputs = {};
			for (const [k, v] of Object.entries(a.inputs)) {
				const n = parseNumber(v);
				if (!n) throw new Error(`input ${k} (${v}) is not a number`);
				inputs[k] = n.value;
			}
			const result = evaluate(a.formula, inputs);
			const id = commit(() => evidence.record(ctx.missionId, { kind: "calculation", source: a.label, derived: { inputs, formula: a.formula, result, sources: a.sources ?? [] }, excerpt: `${a.label} = ${a.formula} = ${result}` }));
			return { content: [{ type: "text", text: `${a.label} = ${result}  (formula ${a.formula} with ${Object.entries(inputs).map(([k, v]) => `${k}=${v}`).join(", ")}; evidence ${id})` }], details: { result, evidenceId: id } };
		},
	};

	const chart = {
		name: "chart_create",
		label: "Create chart",
		description: "Create a bar chart (SVG) and its dataset (CSV) as validated drafts in the mission workspace. Values must come from sheet_read/calculate evidence.",
		parameters: Type.Object({
			title: Type.String(),
			categories: Type.Array(Type.String(), { minItems: 1, maxItems: 40 }),
			series: Type.Array(Type.Object({ name: Type.String(), values: Type.Array(Type.Number()) }), { minItems: 1, maxItems: 5 }),
			unit: Type.Optional(Type.String({ description: "suffix such as k or %" })),
			filename: Type.Optional(Type.String()),
			sources: Type.Optional(Type.Array(Type.String())),
		}),
		classify: (a) => ({ effect: "artifact.stage", target: a.title, canonical: a, feed: `chart › ${a.title}` }),
		async execute(a, ctx) {
			for (const s of a.series) if (s.values.length !== a.categories.length) throw new Error(`series ${s.name} has ${s.values.length} values for ${a.categories.length} categories`);
			const name = a.filename ?? `${a.title.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").toLowerCase() || "chart"}.svg`;
			const svg = barChartSvg({ ...a, note: "midnight" });
			const validation = validateChartSvg(svg, a);
			const dataset = toCsv([["category", ...a.series.map((s) => s.name)], ...a.categories.map((c, i) => [c, ...a.series.map((s) => s.values[i])])]);
			const { art, data } = commit(() => {
				const d = evidence.stage(ctx.missionId, ctx.runId, { name: name.replace(/\.svg$/i, ".csv"), type: "dataset", data: dataset, sources: a.sources ?? [], validation: { ok: true, issues: [], facts: { rows: a.categories.length } } });
				const c = evidence.stage(ctx.missionId, ctx.runId, { name: name.endsWith(".svg") ? name : `${name}.svg`, type: "chart", data: svg, sources: [...(a.sources ?? []), d.id], validation: { ...validation, facts: { ...validation.facts, datasetHash: d.hash } } });
				return { art: c, data: d };
			});
			return {
				content: [{ type: "text", text: `Chart ${art.name} r${art.revision} (${art.id}) ${validation.ok ? "validated" : `FAILED validation: ${validation.issues.join("; ")}`}; totals ${JSON.stringify(validation.facts.totals)}. Dataset ${data.name} (${data.id}).` }],
				details: { artifactId: art.id, datasetId: data.id },
			};
		},
	};

	const report = {
		name: "report_create",
		label: "Create report",
		description: "Write a report as a validated Word document (or Markdown) in the mission workspace: title, sections with text, bullets and tables. Reference charts by name.",
		parameters: Type.Object({
			title: Type.String(),
			subtitle: Type.Optional(Type.String()),
			sections: Type.Array(
				Type.Object({
					heading: Type.String(),
					text: Type.Optional(Type.String()),
					bullets: Type.Optional(Type.Array(Type.String())),
					table: Type.Optional(Type.Array(Type.Array(Type.String()), { description: "first row is the header" })),
				}),
				{ minItems: 1, maxItems: 30 },
			),
			format: Type.Optional(Type.Union([Type.Literal("docx"), Type.Literal("md")])),
			filename: Type.Optional(Type.String()),
			sources: Type.Optional(Type.Array(Type.String())),
		}),
		classify: (a) => ({ effect: "artifact.stage", target: a.title, canonical: a, feed: `report › ${a.title}` }),
		async execute(a, ctx) {
			const blocks = a.sections.flatMap((s) => [{ type: "heading", level: 1, text: s.heading }, ...(s.text ? s.text.split(/\n{2,}/).map((t) => ({ type: "p", text: t })) : []), ...(s.bullets?.length ? [{ type: "bullets", items: s.bullets }] : []), ...(s.table?.length ? [{ type: "table", rows: s.table }] : [])]);
			const fmtName = a.format ?? "docx";
			const base = a.filename ?? `${a.title.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").toLowerCase() || "report"}.${fmtName}`;
			let data;
			let validation;
			if (fmtName === "docx") {
				const doc = { title: a.title, subtitle: a.subtitle, footer: `Prepared by midnight · ${new Date().toISOString().slice(0, 10)}`, blocks };
				data = writeDocx(doc);
				validation = validateDocx(data, doc);
			} else {
				data = `# ${a.title}\n\n${a.subtitle ? `_${a.subtitle}_\n\n` : ""}${a.sections.map((s) => `## ${s.heading}\n\n${s.text ?? ""}${s.bullets ? `\n${s.bullets.map((b) => `- ${b}`).join("\n")}` : ""}${s.table ? `\n\n${s.table.map((r, i) => `| ${r.join(" | ")} |${i === 0 ? `\n|${r.map(() => "---").join("|")}|` : ""}`).join("\n")}` : ""}`).join("\n\n")}\n`;
				const heads = (data.match(/^## /gm) ?? []).length;
				validation = { ok: heads === a.sections.length, issues: heads === a.sections.length ? [] : ["section count differs"], facts: { headings: heads } };
			}
			const art = commit(() => evidence.stage(ctx.missionId, ctx.runId, { name: base, type: "report", data, sources: a.sources ?? [], validation }));
			return { content: [{ type: "text", text: `Report ${art.name} r${art.revision} (${art.id}) ${validation.ok ? "validated" : `FAILED validation: ${validation.issues.join("; ")}`}.` }], details: { artifactId: art.id } };
		},
	};

	return { all: [sheetRead, calculate, chart, report] };
}
