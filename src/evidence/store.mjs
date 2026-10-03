// Evidence and artifacts (plan ch. 11, T03/T06). Evidence answers "where exactly?": a URL and excerpt, a document
// page, a workbook sheet and range, a connector query, or a derived calculation with its inputs and formula.
// Artifacts are staged in a per-mission workspace, validated, then published with collision-safe names.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { newId } from "../contracts/events.mjs";
import { normalizeUrl } from "../missions/plan.mjs";
import { json } from "../storage/db.mjs";

export const fileHash = (buf) => `sha256:${createHash("sha256").update(buf).digest("hex")}`;

export function createEvidence(store, journal, emit, { workspaces }) {
	const evRow = (r) => ({
		id: r.id,
		missionId: r.mission_id,
		kind: r.kind,
		source: r.source,
		sourceVersion: r.source_version ?? undefined,
		locator: json(r.locator, {}),
		excerpt: journal.getPayload(r.excerpt_ref),
		hash: r.hash ?? undefined,
		capturedAt: r.captured_at,
		freshness: r.freshness ?? undefined,
		derived: json(r.derived, undefined),
	});
	const artRow = (r) =>
		r && {
			id: r.id,
			missionId: r.mission_id,
			runId: r.run_id ?? undefined,
			name: r.name,
			type: r.type,
			revision: r.revision,
			hash: r.content_hash,
			path: r.local_path,
			publishedPath: r.published_path ?? undefined,
			validation: json(r.validation, {}),
			sources: json(r.sources, []),
			toolVersion: r.tool_version,
			status: r.status,
			createdAt: r.created_at,
		};

	const api = {
		/** Call inside a unit of work. */
		record(missionId, { kind, source, sourceVersion, locator = {}, excerpt, hash, freshness, derived }) {
			const id = newId("ev");
			const ref = excerpt ? journal.putPayload(missionId, "excerpt", String(excerpt).slice(0, 4000)) : null;
			store.run(
				"INSERT INTO evidence (id, mission_id, kind, source, source_version, locator, excerpt_ref, hash, captured_at, freshness, derived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				id,
				missionId,
				kind,
				String(source).slice(0, 2000),
				sourceVersion ?? null,
				JSON.stringify(locator),
				ref,
				hash ?? null,
				new Date().toISOString(),
				freshness ?? null,
				derived ? JSON.stringify(derived) : null,
			);
			emit("evidence.recorded", { missionId, payload: { evidenceId: id, kind, count: 1 } });
			return id;
		},
		list: (missionId) => store.all("SELECT * FROM evidence WHERE mission_id = ? ORDER BY captured_at, rowid", missionId).map(evRow),
		get: (id) => {
			const r = store.get("SELECT * FROM evidence WHERE id = ?", id);
			return r && evRow(r);
		},
		retrievedUrls(missionId) {
			const out = new Set();
			for (const r of store.all("SELECT source FROM evidence WHERE mission_id = ? AND kind = 'web'", missionId)) out.add(normalizeUrl(r.source));
			return out;
		},
		counts(missionId) {
			const r = store.get("SELECT COUNT(*) AS n, SUM(kind = 'calculation') AS c FROM evidence WHERE mission_id = ?", missionId);
			return { evidence: Number(r?.n ?? 0), calculations: Number(r?.c ?? 0) };
		},

		workspace(missionId) {
			const dir = path.join(workspaces, missionId);
			fs.mkdirSync(dir, { recursive: true });
			return dir;
		},
		/**
		 * Stage bytes as the next revision of `name` in the mission workspace and record the validation result.
		 * Call inside a unit of work. `validate(buffer)` -> { ok, issues: [], facts }.
		 */
		stage(missionId, runId, { name, type, data, sources = [], toolVersion = "1", validation }) {
			const safe = sanitizeName(name);
			const prev = store.get("SELECT MAX(revision) AS r FROM artifacts WHERE mission_id = ? AND name = ?", missionId, safe);
			const revision = Number(prev?.r ?? 0) + 1;
			const dir = api.workspace(missionId);
			const ext = path.extname(safe);
			const file = path.join(dir, `${path.basename(safe, ext)}.r${revision}${ext}`);
			const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
			fs.writeFileSync(file, buf);
			const id = newId("art");
			const hash = fileHash(buf);
			store.run(
				"INSERT INTO artifacts (id, mission_id, run_id, name, type, revision, content_hash, local_path, validation, sources, tool_version, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				id,
				missionId,
				runId ?? null,
				safe,
				type,
				revision,
				hash,
				file,
				JSON.stringify(validation ?? { ok: false, issues: ["not validated"] }),
				JSON.stringify(sources),
				toolVersion,
				validation?.ok ? "validated" : "staged",
				new Date().toISOString(),
			);
			emit("artifact.validated", { missionId, runId, payload: { artifactId: id, name: safe, type, revision, hash, ok: !!validation?.ok, issues: validation?.issues ?? [], path: file } });
			return api.artifact(id);
		},
		artifact: (id) => artRow(store.get("SELECT * FROM artifacts WHERE id = ?", id)),
		artifacts: (missionId) => store.all("SELECT * FROM artifacts WHERE mission_id = ? ORDER BY created_at, rowid", missionId).map(artRow),
		latest: (missionId, name) => artRow(store.get("SELECT * FROM artifacts WHERE mission_id = ? AND name = ? ORDER BY revision DESC LIMIT 1", missionId, sanitizeName(name))),
		/** Mark a staged artifact as published at `dest` (the file tool did the atomic write). */
		markPublished(id, dest) {
			const a = api.artifact(id);
			store.run("UPDATE artifacts SET published_path = ?, status = 'published' WHERE id = ?", dest, id);
			emit("artifact.published", { missionId: a.missionId, payload: { artifactId: id, path: dest, hash: a.hash } });
		},
	};
	return api;
}

export function sanitizeName(name) {
	const base = path.basename(String(name || "artifact")).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/^\.+/, "").slice(0, 120);
	return base || "artifact";
}

/** A name in `dir` that does not exist yet: report.docx, report (2).docx, ... */
export function collisionSafe(dir, name) {
	const ext = path.extname(name);
	const stem = path.basename(name, ext);
	let candidate = path.join(dir, name);
	for (let i = 2; fs.existsSync(candidate); i++) candidate = path.join(dir, `${stem} (${i})${ext}`);
	return candidate;
}
