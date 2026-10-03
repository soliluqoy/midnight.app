// The action ledger (plan ch. 06). An intent is persisted before any effect is attempted, its state only moves
// along the action state machine, and receipts are append-only. After a crash, anything that may have started
// is "unknown" until reconciled; an unknown intent is never re-dispatched because a model asked again.
import { ACTION_FINAL, canTransitionAction } from "../contracts/domain.mjs";
import { newId } from "../contracts/events.mjs";
import { json } from "../storage/db.mjs";

export const POLICY_VERSION = "policy-1";

export function createLedger(store, { runtimeVersion = "unknown" } = {}) {
	const row = (r) =>
		r && {
			id: r.id,
			missionId: r.mission_id,
			runId: r.run_id ?? undefined,
			tool: r.tool,
			toolVersion: r.tool_version,
			effect: r.effect,
			target: r.target,
			argsHash: r.args_hash,
			argsRef: r.args_ref ?? undefined,
			display: json(r.display, {}),
			authority: json(r.authority, {}),
			idempotencyKey: r.idempotency_key,
			state: r.state,
			attempts: r.attempts,
			policyVersion: r.policy_version,
			runtimeVersion: r.runtime_version,
			createdAt: r.created_at,
			updatedAt: r.updated_at,
		};
	const receiptRow = (r) =>
		r && {
			id: r.id,
			intentId: r.intent_id,
			state: r.state,
			remoteId: r.remote_id ?? undefined,
			resultHash: r.result_hash ?? undefined,
			observed: json(r.observed, {}),
			verification: json(r.verification, []),
			createdAt: r.created_at,
		};

	const api = {
		prepare({ missionId, runId, tool, toolVersion = "1", effect, target = "", argsHash, argsRef, display = {}, idempotencyKey }) {
			const id = newId("act");
			const at = new Date().toISOString();
			store.run(
				"INSERT INTO action_intents (id, mission_id, run_id, tool, tool_version, effect, target, args_hash, args_ref, display, authority, idempotency_key, state, attempts, policy_version, runtime_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, 'prepared', 0, ?, ?, ?, ?)",
				id,
				missionId,
				runId ?? null,
				tool,
				String(toolVersion),
				effect,
				String(target).slice(0, 2000),
				argsHash,
				argsRef ?? null,
				JSON.stringify(display),
				idempotencyKey ?? `midnight-${id}`,
				POLICY_VERSION,
				runtimeVersion,
				at,
				at,
			);
			return api.get(id);
		},
		get: (id) => row(store.get("SELECT * FROM action_intents WHERE id = ?", id)),
		/** Move an intent along the state machine; illegal moves throw. */
		transition(id, to, patch = {}) {
			const cur = api.get(id);
			if (!cur) throw new Error(`no intent ${id}`);
			if (cur.state === to && !patch.authority) return cur;
			if (!canTransitionAction(cur.state, to)) throw new Error(`illegal action transition ${cur.state} -> ${to} (${id})`);
			const sets = ["state = ?", "updated_at = ?"];
			const args = [to, new Date().toISOString()];
			if (patch.authority) {
				sets.push("authority = ?");
				args.push(JSON.stringify(patch.authority));
			}
			if (to === "dispatching") sets.push("attempts = attempts + 1");
			store.run(`UPDATE action_intents SET ${sets.join(", ")} WHERE id = ?`, ...args, id);
			return api.get(id);
		},
		receipt(intentId, { state, remoteId, resultHash, observed = {}, verification = [] }) {
			const id = newId("rcpt");
			store.run(
				"INSERT INTO action_receipts (id, intent_id, state, remote_id, result_hash, observed, verification, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				id,
				intentId,
				state,
				remoteId ?? null,
				resultHash ?? null,
				JSON.stringify(observed),
				JSON.stringify(verification),
				new Date().toISOString(),
			);
			return receiptRow(store.get("SELECT * FROM action_receipts WHERE id = ?", id));
		},
		receipts: (intentId) => store.all("SELECT * FROM action_receipts WHERE intent_id = ? ORDER BY created_at, rowid", intentId).map(receiptRow),
		latestReceipt: (intentId) => receiptRow(store.get("SELECT * FROM action_receipts WHERE intent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", intentId)),
		forMission: (missionId) => store.all("SELECT * FROM action_intents WHERE mission_id = ? ORDER BY created_at, rowid", missionId).map(row),
		/** A prior intent with the same canonical identity in this mission that blocks a fresh dispatch. */
		blockingTwin(missionId, argsHash) {
			return row(store.get("SELECT * FROM action_intents WHERE mission_id = ? AND args_hash = ? AND state IN ('unknown','dispatching','acknowledged','verifying') ORDER BY created_at DESC LIMIT 1", missionId, argsHash));
		},
		/** A prior verified intent with the same identity (to refuse a duplicate external effect). */
		verifiedTwin(missionId, argsHash) {
			return row(store.get("SELECT * FROM action_intents WHERE mission_id = ? AND args_hash = ? AND state = 'verified' ORDER BY created_at DESC LIMIT 1", missionId, argsHash));
		},
		inFlight: () => store.all("SELECT * FROM action_intents WHERE state IN ('dispatching','acknowledged','verifying')").map(row),
		unresolved: () => store.all("SELECT * FROM action_intents WHERE state = 'unknown'").map(row),
		notDispatched: () => store.all("SELECT * FROM action_intents WHERE state IN ('prepared','authorized')").map(row),
		isFinal: (state) => ACTION_FINAL.has(state),
	};
	return api;
}
