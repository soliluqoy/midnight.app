// Editable memory (plan ch. 13, K01). Explicit preferences and facts with provenance, confirmation, validity and
// supersession; SQLite full-text search, scoped and small. Conversation compaction is not memory. Model suggestions
// stay unconfirmed and are never retrieved until the user confirms them, so content cannot turn itself into a
// standing instruction. Forget removes the record and its index entry.
import { newId } from "../contracts/events.mjs";
import { json } from "../storage/db.mjs";

const norm = (t) => String(t).toLowerCase().replace(/\s+/g, " ").trim();
const STOP = new Set("the a an and or of to in on for with is are be it this that my me i you your at by as from".split(" "));

export function createMemory(store, emit, commit) {
	const row = (r) =>
		r && {
			id: r.id,
			kind: r.kind,
			text: r.text,
			scope: json(r.scope, {}),
			provenance: json(r.provenance, {}),
			confirmed: !!r.confirmed,
			sensitivity: r.sensitivity,
			confidence: r.confidence,
			validUntil: r.valid_until ?? undefined,
			supersededBy: r.superseded_by ?? undefined,
			uses: r.uses,
			lastUsedAt: r.last_used_at ?? undefined,
			createdAt: r.created_at,
			updatedAt: r.updated_at,
		};
	const changed = (id, what) => emit("memory.changed", { payload: { memoryId: id, what } });

	function insert(text, { kind = "preference", confirmed, provenance, confidence = 1, validUntil, scope = {} }) {
		const dup = store.all("SELECT * FROM memory WHERE superseded_by IS NULL").find((r) => norm(r.text) === norm(text));
		if (dup) return { ...row(dup), duplicate: true };
		const id = newId("mem");
		const at = new Date().toISOString();
		store.run(
			"INSERT INTO memory (id, kind, text, scope, provenance, confirmed, confidence, valid_until, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			id,
			kind,
			String(text).slice(0, 2000),
			JSON.stringify(scope),
			JSON.stringify(provenance),
			confirmed ? 1 : 0,
			confidence,
			validUntil ?? null,
			at,
			at,
		);
		changed(id, "added");
		return row(store.get("SELECT * FROM memory WHERE id = ?", id));
	}

	const api = {
		/** Something the user stated directly (trusted UI). */
		remember: (text, o = {}) => commit(() => insert(text, { ...o, confirmed: true, provenance: { by: "user", at: new Date().toISOString() } })),
		/** Something a model inferred: a suggestion until the user confirms it. */
		suggest: (text, { kind, missionId } = {}) => commit(() => insert(text, { kind, confirmed: false, confidence: 0.5, provenance: { by: "model", missionId, at: new Date().toISOString() } })),
		confirm(id) {
			commit(() => {
				store.run("UPDATE memory SET confirmed = 1, confidence = 1, updated_at = ? WHERE id = ?", new Date().toISOString(), id);
				changed(id, "confirmed");
			});
			return api.get(id);
		},
		get: (id) => row(store.get("SELECT * FROM memory WHERE id = ?", id)),
		/** Correct = a new record that supersedes the old one (the history of why stays inspectable). */
		correct(id, text) {
			return commit(() => {
				const old = api.get(id);
				if (!old) throw new Error("no such memory");
				const next = insert(text, { kind: old.kind, confirmed: true, provenance: { by: "user", corrects: id, at: new Date().toISOString() }, scope: old.scope });
				store.run("UPDATE memory SET superseded_by = ?, updated_at = ? WHERE id = ?", next.id, new Date().toISOString(), id);
				changed(id, "superseded");
				return next;
			});
		},
		forget(id) {
			return commit(() => {
				const ok = store.run("DELETE FROM memory WHERE id = ?", id).changes > 0;
				if (ok) changed(id, "forgotten");
				return { ok };
			});
		},
		list(query) {
			const rows = query?.trim() ? api.search(query, { includeUnconfirmed: true, limit: 200 }) : store.all("SELECT * FROM memory WHERE superseded_by IS NULL ORDER BY confirmed, updated_at DESC").map(row);
			return rows.map((m) => ({ ...m, why: m.provenance.by === "user" ? "You told midnight" : `Suggested during a mission${m.provenance.missionId ? ` (${m.provenance.missionId})` : ""}; not used until you confirm it` }));
		},
		search(query, { includeUnconfirmed = false, limit = 10, now = new Date() } = {}) {
			const terms = String(query)
				.toLowerCase()
				.match(/[\p{L}\p{N}]{3,}/gu)
				?.filter((t) => !STOP.has(t))
				.slice(0, 12);
			if (!terms?.length) return [];
			const q = terms.map((t) => `"${t.replace(/"/g, "")}"*`).join(" OR ");
			let rows;
			try {
				rows = store.all("SELECT m.* FROM memory_fts f JOIN memory m ON m.rowid = f.rowid WHERE memory_fts MATCH ? ORDER BY bm25(memory_fts) LIMIT ?", q, limit * 3);
			} catch {
				rows = [];
			}
			return rows
				.map(row)
				.filter((m) => !m.supersededBy && (includeUnconfirmed || m.confirmed) && (!m.validUntil || new Date(m.validUntil) > now))
				.slice(0, limit);
		},
		/** The small, relevant, confirmed subset that goes into a model's context. */
		relevant(query, { limit = 6 } = {}) {
			const hits = api.search(query, { limit });
			const prefs = store.all("SELECT * FROM memory WHERE kind = 'preference' AND confirmed = 1 AND superseded_by IS NULL ORDER BY uses DESC, updated_at DESC LIMIT 3").map(row);
			const out = [...new Map([...hits, ...prefs].map((m) => [m.id, m])).values()].slice(0, limit);
			if (out.length) commit(() => store.run(`UPDATE memory SET uses = uses + 1, last_used_at = ? WHERE id IN (${out.map(() => "?").join(",")})`, new Date().toISOString(), ...out.map((m) => m.id)));
			return out;
		},
		exportAll: () => ({ exportedAt: new Date().toISOString(), memories: store.all("SELECT * FROM memory ORDER BY created_at").map(row) }),
		clear: () => commit(() => store.run("DELETE FROM memory")),
	};
	return api;
}
