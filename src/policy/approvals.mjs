// Exact approvals (plan ch. 06, 14). An approval is bound to one intent hash and a nonce that only the trusted
// capsule UI receives. It must be displayed before it can be decided, expires, and is invalidated when the
// intent changes. Pending approvals survive a restart as proposals and are revalidated before dispatch.
import { randomBytes } from "node:crypto";
import { newId } from "../contracts/events.mjs";
import { json } from "../storage/db.mjs";

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

export function createApprovals(store) {
	const waiters = new Map(); // approvalId -> resolve(decision)
	const row = (r) =>
		r && {
			id: r.id,
			intentId: r.intent_id,
			missionId: r.mission_id,
			intentHash: r.intent_hash,
			nonce: r.nonce,
			status: r.status,
			display: json(r.display, {}),
			createdAt: r.created_at,
			displayedAt: r.displayed_at ?? undefined,
			decidedAt: r.decided_at ?? undefined,
			decision: r.decision ?? undefined,
			expiresAt: r.expires_at,
		};

	const api = {
		request({ intentId, missionId, intentHash, display, ttlMs = DEFAULT_TTL_MS, now = new Date() }) {
			const id = newId("apr");
			const nonce = randomBytes(12).toString("hex");
			store.run(
				"INSERT INTO approvals (id, intent_id, mission_id, intent_hash, nonce, status, display, created_at, expires_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)",
				id,
				intentId,
				missionId,
				intentHash,
				nonce,
				JSON.stringify(display),
				now.toISOString(),
				new Date(now.getTime() + ttlMs).toISOString(),
			);
			return api.get(id);
		},
		get: (id) => row(store.get("SELECT * FROM approvals WHERE id = ?", id)),
		pending: (missionId) =>
			(missionId ? store.all("SELECT * FROM approvals WHERE status = 'pending' AND mission_id = ? ORDER BY created_at", missionId) : store.all("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at")).map(row),
		forIntent: (intentId) => row(store.get("SELECT * FROM approvals WHERE intent_id = ? ORDER BY created_at DESC LIMIT 1", intentId)),
		markDisplayed(id, nonce, now = new Date()) {
			const a = api.get(id);
			if (!a || a.nonce !== nonce || a.status !== "pending") return false;
			if (!a.displayedAt) store.run("UPDATE approvals SET displayed_at = ? WHERE id = ?", now.toISOString(), id);
			return true;
		},
		/**
		 * Record a trusted decision. Returns { ok, approval } or { ok: false, error }.
		 * `currentHash` is the intent's hash now; a mismatch means the draft changed after review.
		 */
		decide(id, { nonce, intentHash, decision, currentHash, now = new Date() }) {
			const a = api.get(id);
			if (!a) return { ok: false, error: "no such approval" };
			if (a.status !== "pending") return { ok: false, error: `approval already ${a.status}` };
			if (a.nonce !== nonce) return { ok: false, error: "approval did not come from the displayed card" };
			if (!a.displayedAt) return { ok: false, error: "approval was never displayed" };
			if (new Date(a.expiresAt) <= now) {
				api.close(id, "expired", now);
				return { ok: false, error: "approval expired; review it again" };
			}
			if (a.intentHash !== intentHash || (currentHash && currentHash !== a.intentHash)) {
				api.close(id, "invalidated", now);
				return { ok: false, error: "the action changed after you reviewed it" };
			}
			const status = decision === "approve" || decision === "allow-routine" ? "approved" : "declined";
			store.run("UPDATE approvals SET status = ?, decision = ?, decided_at = ? WHERE id = ?", status, decision, now.toISOString(), id);
			const out = api.get(id);
			waiters.get(id)?.(out);
			waiters.delete(id);
			return { ok: true, approval: out };
		},
		close(id, status, now = new Date()) {
			store.run("UPDATE approvals SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'", status, now.toISOString(), id);
			const out = api.get(id);
			waiters.get(id)?.(out);
			waiters.delete(id);
			return out;
		},
		/** Resolve when decided (or closed). The abort signal closes it as cancelled. */
		wait(id, signal) {
			const cur = api.get(id);
			if (cur && cur.status !== "pending") return Promise.resolve(cur);
			return new Promise((resolve) => {
				waiters.set(id, resolve);
				signal?.addEventListener("abort", () => resolve(api.close(id, "cancelled")), { once: true });
			});
		},
		hasWaiter: (id) => waiters.has(id),
	};
	return api;
}
