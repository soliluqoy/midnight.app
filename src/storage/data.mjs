// Export, retention deletion and a redacted diagnostics preview (plan ch. 13, 18, 23; D02/D03). Deletion goes
// through trusted controls only. Operational receipts of external effects stay discoverable unless the user deletes
// everything, because a database cleanup does not undo a remote action.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { redact } from "../policy/redaction.mjs";
import { json } from "./db.mjs";

export function createData({ store, journal, commit, paths, memory, version }) {
	const tables = ["missions", "runs", "plan_revisions", "step_states", "action_intents", "action_receipts", "grants", "watches", "artifacts", "evidence", "notifications", "recipes", "roots"];
	return {
		exportAll() {
			const out = { exportedAt: new Date().toISOString(), app: version, schema: store.schema };
			for (const t of tables) out[t] = store.all(`SELECT * FROM ${t}`);
			out.approvals = store.all("SELECT id, intent_id, mission_id, status, display, created_at, decided_at, decision FROM approvals"); // no nonces
			out.memory = memory.exportAll().memories;
			out.answers = store.all("SELECT ref, mission_id, created_at, body FROM payloads WHERE kind = 'answer'");
			fs.mkdirSync(paths.exports, { recursive: true });
			const file = path.join(paths.exports, `midnight-export-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
			fs.writeFileSync(file, JSON.stringify(out, null, 1));
			return { file, missions: out.missions.length };
		},
		/** scope: "history" (finished missions' content), "memory", or "all". */
		remove(scope) {
			const removed = {};
			if (scope === "memory" || scope === "all") {
				memory.clear();
				removed.memory = true;
			}
			if (scope === "history" || scope === "all") {
				const done = store.all("SELECT id FROM missions WHERE status IN ('succeeded','partially-succeeded','failed','cancelled')").map((r) => r.id);
				commit(() => {
					for (const id of done) {
						store.run("DELETE FROM payloads WHERE mission_id = ?", id);
						store.run("DELETE FROM evidence WHERE mission_id = ?", id);
						store.run("DELETE FROM artifacts WHERE mission_id = ?", id);
						store.run("DELETE FROM step_states WHERE mission_id = ?", id);
						store.run("DELETE FROM plan_revisions WHERE mission_id = ?", id);
						store.run("UPDATE missions SET goal = '[deleted]', archived = 1 WHERE id = ?", id);
						if (scope === "all") {
							store.run("DELETE FROM action_receipts WHERE intent_id IN (SELECT id FROM action_intents WHERE mission_id = ?)", id);
							store.run("DELETE FROM action_intents WHERE mission_id = ?", id);
							store.run("DELETE FROM runs WHERE mission_id = ?", id);
							store.run("DELETE FROM events WHERE mission_id = ?", id);
							store.run("DELETE FROM missions WHERE id = ?", id);
						}
					}
				});
				for (const id of done) {
					fs.rmSync(path.join(paths.sessions, id), { recursive: true, force: true });
					fs.rmSync(path.join(paths.workspaces, id), { recursive: true, force: true });
				}
				removed.missions = done.length;
			}
			if (scope === "all") {
				commit(() => {
					for (const t of ["watches", "occurrences", "notifications", "recipes", "grants", "approvals", "questions", "secrets"]) store.run(`DELETE FROM ${t}`);
				});
				removed.everything = true;
			}
			return removed;
		},
		/** What a support bundle would contain. No prompts, file contents, screenshots or secrets. */
		diagnostics() {
			const count = (t) => Number(store.get(`SELECT COUNT(*) AS n FROM ${t}`).n);
			const recent = journal.after(Math.max(0, journal.lastSeq() - 200)).map((e) => ({ seq: e.seq, at: e.occurredAt, type: e.type, mission: e.missionId ? `${e.missionId.slice(0, 8)}…` : "", state: e.payload?.state ?? e.payload?.to ?? e.payload?.status ?? "", code: e.payload?.code }));
			const bundle = {
				app: version,
				schema: store.schema,
				platform: `${process.platform} ${os.release()} ${process.arch}`,
				node: process.versions.node,
				electron: process.versions.electron,
				counts: Object.fromEntries(["missions", "runs", "action_intents", "grants", "watches", "memory", "artifacts"].map((t) => [t, count(t)])),
				intents: store.all("SELECT state, effect, COUNT(*) AS n FROM action_intents GROUP BY state, effect"),
				recentEvents: recent,
				readOnly: store.readOnly,
			};
			return { preview: JSON.parse(redact(JSON.stringify(bundle))), note: "This is everything the support bundle contains. Prompts, answers, file contents, screenshots and secrets are left out." };
		},
	};
}

export { json };
