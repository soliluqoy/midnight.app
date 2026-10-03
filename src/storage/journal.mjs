// Append-only domain journal plus a separate payload store for content (answers, excerpts, message bodies).
// Listeners hear an event only after its transaction commits, so nothing is shown before it is stored.
import { randomUUID } from "node:crypto";
import { json } from "./db.mjs";

export function createJournal(store) {
	const listeners = new Set();
	let pending = []; // events appended inside the current transaction

	const flush = () => {
		const out = pending;
		pending = [];
		for (const e of out) for (const l of listeners) l(e);
	};

	return {
		/** Store an event (inside the caller's transaction when there is one) and return it with its seq. */
		append(event) {
			const r = store.run(
				"INSERT INTO events (id, schema_version, mission_id, run_id, type, occurred_at, correlation_id, payload, payload_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				event.id,
				event.schemaVersion,
				event.missionId ?? "",
				event.runId ?? null,
				event.type,
				event.occurredAt,
				event.correlationId,
				JSON.stringify(event.payload ?? {}),
				event.payloadRef ?? null,
			);
			const stored = { ...event, seq: Number(r.lastInsertRowid) };
			pending.push(stored);
			return stored;
		},
		/** Call after the transaction that appended events commits. */
		commit: flush,
		/** Drop events of a rolled-back transaction. */
		rollback() {
			pending = [];
		},
		after(seq, limit = 5000) {
			return store.all("SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?", seq, limit).map(row);
		},
		forMission(missionId) {
			return store.all("SELECT * FROM events WHERE mission_id = ? ORDER BY seq", missionId).map(row);
		},
		lastSeq: () => Number(store.get("SELECT MAX(seq) AS s FROM events")?.s ?? 0),
		subscribe(fn) {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
		putPayload(missionId, kind, body) {
			const ref = `p_${randomUUID().replace(/-/g, "")}`;
			store.run("INSERT INTO payloads (ref, mission_id, kind, body, created_at) VALUES (?, ?, ?, ?, ?)", ref, missionId ?? "", kind, typeof body === "string" ? body : JSON.stringify(body), new Date().toISOString());
			return ref;
		},
		getPayload(ref) {
			return ref ? store.get("SELECT body FROM payloads WHERE ref = ?", ref)?.body : undefined;
		},
	};
}

const row = (r) => ({
	schemaVersion: r.schema_version,
	id: r.id,
	seq: Number(r.seq),
	missionId: r.mission_id,
	runId: r.run_id ?? undefined,
	occurredAt: r.occurred_at,
	type: r.type,
	correlationId: r.correlation_id,
	payload: json(r.payload, {}),
	payloadRef: r.payload_ref ?? undefined,
});
