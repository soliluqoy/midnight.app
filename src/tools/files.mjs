// Scoped file tools (plan ch. 11, T01). Discovery and reading stay inside folders the user selected; names,
// sizes and dates first, content on demand. Paths are canonicalized with realpath at dispatch so a junction or
// symlink cannot lead outside a selected folder. Writes are atomic (temp file in the destination folder, then
// rename) and check the preimage hash; moves never delete and leave an undo manifest.
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { fileHash } from "../evidence/store.mjs";
import { within } from "../policy/grants.mjs";
import { realTarget } from "../policy/roots.mjs";
import { readDocx } from "./documents/docx.mjs";
import { readXlsx } from "./documents/xlsx.mjs";

const SKIP_DIRS = /^(node_modules|\.git|\.svn|\$recycle\.bin|system volume information|appdata|\.cache|cache|temp|tmp|__pycache__|\.venv)$/i;
const SECRET = /(^\.env(\..*)?$|\.pem$|\.key$|\.pfx$|\.p12$|^id_(rsa|ed25519|ecdsa)|\.kdbx$|credentials|secret|password|token)/i;
const MAX_LIST = 400;
const MAX_WALK = 20000;
const BIG = 200 * 1024 * 1024;

export const TYPES = { xlsx: "spreadsheet", xlsm: "spreadsheet", csv: "spreadsheet", tsv: "spreadsheet", docx: "document", pdf: "pdf", md: "text", txt: "text", json: "text", pptx: "slides", png: "image", jpg: "image", jpeg: "image", svg: "image", eml: "mail" };
const typeOf = (f) => TYPES[path.extname(f).slice(1).toLowerCase()] ?? "other";

export { realTarget };

/** Throw unless `p` (after resolving links) is inside one of `roots`. */
export function assertInside(roots, p, what = "path") {
	const real = realTarget(p);
	const root = roots.find((r) => within(r.path, real));
	if (!root) throw new Error(`${what} ${p} is outside your selected folders${real !== path.resolve(p) ? ` (it resolves to ${real})` : ""}`);
	return { real, root };
}

/** Why a file was picked: words people use for versions, recency, size. Timestamps alone are not authority. */
function versionHints(name) {
	const n = name.toLowerCase();
	return {
		final: /\bfinal\b|_final|-final|\bapproved\b|\bsigned\b/.test(n),
		draft: /\bdraft\b|_draft|-draft|\bwip\b|\bold\b|\bcopy\b|\(\d+\)|\bv\d+\b/.test(n),
	};
}

export function walk(root, { pattern, types, modifiedAfter, maxDepth = 6 } = {}) {
	const out = [];
	let seen = 0;
	const re = pattern ? new RegExp(pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, "."), "i") : null;
	const visit = (dir, depth) => {
		let entries = [];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (++seen > MAX_WALK || out.length >= MAX_LIST * 4) return;
			const full = path.join(dir, e.name);
			if (e.isSymbolicLink()) continue; // never follow links during discovery
			if (e.isDirectory()) {
				if (!SKIP_DIRS.test(e.name) && !e.name.startsWith(".") && depth < maxDepth) visit(full, depth + 1);
				continue;
			}
			if (SECRET.test(e.name)) continue;
			if (re && !re.test(e.name) && !re.test(path.relative(root, full))) continue;
			const type = typeOf(e.name);
			if (types?.length && !types.includes(type) && !types.includes(path.extname(e.name).slice(1).toLowerCase())) continue;
			let st;
			try {
				st = fs.statSync(full);
			} catch {
				continue;
			}
			if (modifiedAfter && st.mtime < new Date(modifiedAfter)) continue;
			out.push({ path: full, name: e.name, type, size: st.size, modified: st.mtime.toISOString(), big: st.size > BIG, ...versionHints(e.name) });
		}
	};
	visit(root, 0);
	return out;
}

/** Flag final-vs-draft pairs that look like versions of the same thing. */
export function ambiguity(files) {
	const stem = (n) =>
		n
			.toLowerCase()
			.replace(/\.[^.]+$/, "")
			.replace(/\b(final|draft|wip|old|copy|approved|signed|v\d+)\b|[_\-\s()\d]+/g, "");
	const groups = new Map();
	for (const f of files) {
		const k = `${stem(f.name)}|${f.type}`;
		if (!groups.has(k)) groups.set(k, []);
		groups.get(k).push(f);
	}
	return [...groups.values()].filter((g) => g.length > 1).map((g) => g.map((f) => f.path));
}

export function fileTools({ roots, evidence, commit, settings, paths }) {
	const allRoots = () => roots.list();
	const backupDir = path.join(paths.backups, "files");

	const filesFind = {
		name: "files_find",
		label: "Find files",
		description:
			"Find files by name inside the folders the user selected (names, types, sizes and dates; no content). Use a pattern like *sales*q3* and types like spreadsheet, document, pdf. " +
			"Results say why each file might be the right one and flag final-vs-draft look-alikes; when two plausible versions differ, ask the user.",
		parameters: Type.Object({
			pattern: Type.Optional(Type.String({ description: "name pattern with * and ?, e.g. *q3*sales*" })),
			types: Type.Optional(Type.Array(Type.String(), { description: "spreadsheet, document, pdf, text, image, slides, or extensions" })),
			folder: Type.Optional(Type.String({ description: "one selected folder (path or name); default all" })),
			modifiedAfter: Type.Optional(Type.String({ description: "ISO date" })),
		}),
		classify(a) {
			const rs = allRoots().filter((r) => !a.folder || r.path.toLowerCase().includes(a.folder.toLowerCase()) || r.label.toLowerCase() === a.folder.toLowerCase());
			if (!rs.length) throw new Error(allRoots().length ? `no selected folder matches ${a.folder}` : "no folders are selected yet; ask the user to add one in Settings → Sources");
			return { effect: "read.local", paths: rs.map((r) => r.path), target: rs.map((r) => r.label).join(", "), canonical: a, feed: `files › find ${a.pattern ?? "*"} in ${rs.map((r) => r.label).join(", ")}`, icon: "◎" };
		},
		async execute(a) {
			const rs = allRoots().filter((r) => !a.folder || r.path.toLowerCase().includes(a.folder.toLowerCase()) || r.label.toLowerCase() === a.folder.toLowerCase());
			let files = rs.flatMap((r) => walk(r.path, { pattern: a.pattern, types: a.types, modifiedAfter: a.modifiedAfter }));
			files.sort((x, y) => Number(y.final) - Number(x.final) || Number(x.draft) - Number(y.draft) || (y.modified > x.modified ? 1 : -1));
			const amb = ambiguity(files);
			files = files.slice(0, MAX_LIST);
			const lines = files.map((f) => {
				const why = [f.final && "named final", f.draft && "looks like a draft or copy", f.big && "very large (content not read)"].filter(Boolean).join(", ");
				return `- ${f.path} · ${f.type} · ${Math.round(f.size / 1024)} KB · modified ${f.modified.slice(0, 16).replace("T", " ")}${why ? ` · ${why}` : ""}`;
			});
			const note = amb.length ? `\n\nPossible versions of the same file (check content or ask the user before choosing):\n${amb.map((g) => `- ${g.join("  vs  ")}`).join("\n")}` : "";
			return { content: [{ type: "text", text: files.length ? `${files.length} file${files.length > 1 ? "s" : ""}:\n${lines.join("\n")}${note}` : "No matching files in the selected folders." }], details: { count: files.length } };
		},
	};

	const filesRead = {
		name: "files_read",
		label: "Read file",
		description: "Read a text-like file inside a selected folder: txt, md, csv, json, docx (text, headings, tables). For spreadsheets use sheet_read. Macros are never run.",
		parameters: Type.Object({ path: Type.String(), maxChars: Type.Optional(Type.Integer({ minimum: 500, maximum: 60000 })) }),
		classify: (a) => ({ effect: "read.local", paths: [a.path], target: a.path, canonical: { path: path.resolve(a.path) }, feed: `files › read ${path.basename(a.path)}`, resources: [{ key: `file:${path.resolve(a.path).toLowerCase()}`, mode: "read" }] }),
		async execute(a, ctx) {
			const { real } = assertInside(allRoots(), a.path, "file");
			const st = fs.statSync(real);
			if (st.size > 50 * 1024 * 1024) throw new Error("file is larger than 50 MB; Midnight does not read it whole");
			const buf = fs.readFileSync(real);
			const ext = path.extname(real).toLowerCase();
			let text;
			if (ext === ".docx") {
				const d = readDocx(buf);
				text = d.blocks.map((b) => (b.type === "heading" ? `${"#".repeat(Math.max(1, b.level))} ${b.text}` : b.type === "table" ? b.rows.map((r) => `| ${r.join(" | ")} |`).join("\n") : b.text)).join("\n\n");
				if (d.macros) text = `[This document contains macros; they were not run.]\n\n${text}`;
			} else if ([".xlsx", ".xlsm"].includes(ext)) {
				const b = readXlsx(buf);
				text = `Workbook with sheets: ${b.sheets.map((s) => `${s.name}${s.hidden ? " (hidden)" : ""} ${s.maxRow}x${s.maxCol}`).join(", ")}. Use sheet_read for values.`;
			} else if ([".pdf", ".png", ".jpg", ".jpeg", ".pptx", ".exe", ".dll", ".zip"].includes(ext)) {
				throw new Error(`${ext} files are not read as text here`);
			} else text = buf.toString("utf8");
			const max = a.maxChars ?? 20000;
			const hash = fileHash(buf);
			commit(() => evidence.record(ctx.missionId, { kind: "file", source: real, sourceVersion: `${st.mtime.toISOString()}|${st.size}`, hash, excerpt: text.slice(0, 600), locator: { chars: Math.min(max, text.length) } }));
			return { content: [{ type: "text", text: `${real} (${hash.slice(0, 19)}…, modified ${st.mtime.toISOString().slice(0, 16)})\n\n${text.length > max ? `${text.slice(0, max)}\n[truncated ${text.length - max} chars]` : text}` }], details: { path: real, hash } };
		},
	};

	const publish = {
		name: "file_publish",
		label: "Save to folder",
		description:
			"Save a staged artifact (from chart_create, report_create, mail_draft…) into a selected output folder. Never overwrites unless overwrite is true and the file is still the version you read (expectHash).",
		parameters: Type.Object({
			artifactId: Type.String(),
			folder: Type.String({ description: "a selected folder path" }),
			filename: Type.Optional(Type.String()),
			overwrite: Type.Optional(Type.Boolean()),
			expectHash: Type.Optional(Type.String({ description: "sha256 of the file being replaced, from files_read" })),
		}),
		classify(a) {
			const art = evidence.artifact(a.artifactId);
			if (!art) throw new Error(`no artifact ${a.artifactId}`);
			const dest = path.join(path.resolve(a.folder), path.basename(a.filename ?? art.name));
			return {
				effect: "local.write",
				paths: [dest],
				target: dest,
				canonical: { artifactHash: art.hash, dest: dest.toLowerCase(), overwrite: !!a.overwrite, expectHash: a.expectHash ?? null },
				resources: [{ key: `file:${dest.toLowerCase()}`, mode: "write" }],
				display: { title: `Save ${path.basename(dest)} to ${path.dirname(dest)}`, verb: "Save", attachments: [{ name: art.name, revision: art.revision, hash: art.hash }], consequence: a.overwrite ? "This replaces the existing file (a backup is kept)." : "This adds a new file; nothing is overwritten." },
				feed: `files › save ${path.basename(dest)}`,
			};
		},
		async execute(a, ctx) {
			const art = evidence.artifact(a.artifactId);
			const { real } = assertInside(allRoots(), path.join(a.folder, path.basename(a.filename ?? art.name)), "destination");
			const data = fs.readFileSync(art.path);
			if (fileHash(data) !== art.hash) throw new Error("the staged artifact changed after it was validated");
			let dest = real;
			let backup;
			if (fs.existsSync(dest)) {
				if (!a.overwrite) {
					const { collisionSafe } = await import("../evidence/store.mjs");
					dest = collisionSafe(path.dirname(dest), path.basename(dest));
				} else {
					const pre = fileHash(fs.readFileSync(dest));
					if (a.expectHash && a.expectHash !== pre) throw Object.assign(new Error(`${path.basename(dest)} changed since it was read; not overwriting`), { code: "CONFLICT" });
					fs.mkdirSync(backupDir, { recursive: true });
					backup = path.join(backupDir, `${Date.now()}-${path.basename(dest)}`);
					fs.copyFileSync(dest, backup);
				}
			}
			atomicWrite(dest, data);
			commit(() => evidence.markPublished(art.id, dest));
			return { content: [{ type: "text", text: `Saved ${dest}${backup ? ` (previous version backed up)` : ""}.` }], observed: { path: dest, hash: art.hash, backup }, details: { path: dest } };
		},
		async verify(a, out) {
			const p = out.observed.path;
			return fs.existsSync(p) && fileHash(fs.readFileSync(p)) === out.observed.hash ? { state: "verified", refs: [`${p} ${out.observed.hash}`] } : { state: "failed", refs: ["file on disk does not match"] };
		},
	};

	const move = {
		name: "files_move",
		label: "Move files",
		description: "Move files between selected folders (for tidying). Never deletes, never overwrites; writes an undo manifest. Executables are not moved.",
		parameters: Type.Object({ moves: Type.Array(Type.Object({ from: Type.String(), to: Type.String({ description: "destination folder" }) }), { minItems: 1, maxItems: 200 }) }),
		classify(a) {
			const ps = a.moves.flatMap((m) => [m.from, path.join(m.to, path.basename(m.from))]);
			if (a.moves.some((m) => /\.(exe|msi|bat|cmd|ps1|lnk|scr)$/i.test(m.from))) return { effect: "local.move", approvable: false, denyReason: "Midnight does not move executables or scripts", canonical: a, target: "", paths: ps };
			return {
				effect: "local.move",
				paths: ps,
				target: `${a.moves.length} file${a.moves.length > 1 ? "s" : ""}`,
				canonical: { moves: a.moves.map((m) => ({ from: path.resolve(m.from).toLowerCase(), to: path.resolve(m.to).toLowerCase() })) },
				resources: ps.map((p) => ({ key: `file:${path.resolve(p).toLowerCase()}`, mode: "write" })),
				display: { title: `Move ${a.moves.length} file${a.moves.length > 1 ? "s" : ""}`, verb: "Move them", preview: a.moves.slice(0, 20).map((m) => `${path.basename(m.from)} → ${m.to}`).join("\n"), consequence: "Files move; nothing is deleted and an undo list is kept." },
				feed: `files › move ${a.moves.length} file${a.moves.length > 1 ? "s" : ""}`,
			};
		},
		async execute(a, ctx) {
			const done = [];
			const skipped = [];
			for (const m of a.moves) {
				try {
					const { real: from } = assertInside(allRoots(), m.from, "file");
					const { real: dir } = assertInside(allRoots(), m.to, "destination");
					fs.mkdirSync(dir, { recursive: true });
					let to = path.join(dir, path.basename(from));
					if (fs.existsSync(to)) {
						const { collisionSafe } = await import("../evidence/store.mjs");
						to = collisionSafe(dir, path.basename(from));
					}
					fs.renameSync(from, to);
					done.push({ from, to });
				} catch (err) {
					skipped.push({ from: m.from, reason: err.message });
				}
			}
			const manifest = path.join(evidence.workspace(ctx.missionId), `moves-${Date.now()}.json`);
			fs.writeFileSync(manifest, JSON.stringify({ at: new Date().toISOString(), moves: done }, null, 2));
			return {
				content: [{ type: "text", text: `Moved ${done.length} file${done.length === 1 ? "" : "s"}${skipped.length ? `; skipped ${skipped.length}: ${skipped.map((s) => `${path.basename(s.from)} (${s.reason})`).join("; ")}` : ""}. Undo list: ${manifest}` }],
				observed: { moved: done.length, skipped: skipped.length, manifest },
				details: { manifest },
			};
		},
		verify: async (a, out) => {
			const m = JSON.parse(fs.readFileSync(out.observed.manifest, "utf8"));
			const ok = m.moves.every((x) => fs.existsSync(x.to) && !fs.existsSync(x.from));
			return ok ? { state: "verified", refs: [out.observed.manifest] } : { state: "failed", refs: ["some files are not where the manifest says"] };
		},
	};

	const undo = {
		name: "files_undo_moves",
		label: "Undo moves",
		description: "Put files back using an undo manifest written by files_move.",
		parameters: Type.Object({ manifest: Type.String() }),
		classify(a) {
			const m = JSON.parse(fs.readFileSync(a.manifest, "utf8"));
			const ps = m.moves.flatMap((x) => [x.to, x.from]);
			return { effect: "local.move", paths: ps, target: `${m.moves.length} files`, canonical: { manifest: path.resolve(a.manifest).toLowerCase() }, resources: ps.map((p) => ({ key: `file:${p.toLowerCase()}`, mode: "write" })), feed: `files › undo ${m.moves.length} moves` };
		},
		async execute(a) {
			const m = JSON.parse(fs.readFileSync(a.manifest, "utf8"));
			let n = 0;
			for (const x of m.moves.reverse()) {
				if (fs.existsSync(x.to) && !fs.existsSync(x.from)) {
					fs.renameSync(x.to, x.from);
					n++;
				}
			}
			return { content: [{ type: "text", text: `Put back ${n} of ${m.moves.length} files.` }], observed: { restored: n } };
		},
	};

	return { all: [filesFind, filesRead, publish, move, undo] };
}

export function atomicWrite(dest, data) {
	const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.midnight-${process.pid}-${Date.now()}.tmp`);
	const fd = fs.openSync(tmp, "wx");
	try {
		fs.writeSync(fd, data);
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	fs.renameSync(tmp, dest);
}
