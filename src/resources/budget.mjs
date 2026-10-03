// Budget governor (plan ch. 09, G01). Work is reserved before it starts and settled with actual usage after.
// A hard cap blocks new dispatch; retries, summaries and verifier calls all count. Cost that a provider does not
// report stays "unknown" rather than being invented.
import { newId } from "../contracts/events.mjs";
import { json } from "../storage/db.mjs";

export const DEFAULT_LIMITS = { tokens: 2_000_000, costUsd: 2, toolCalls: 300, modelCalls: 120, wallMinutes: 60 };
const KEYS = ["tokens", "costUsd", "toolCalls", "modelCalls"];

export function createBudgets(store) {
	const row = (r) =>
		r && {
			id: r.id,
			missionId: r.mission_id,
			limits: json(r.limits, {}),
			spent: { tokens: 0, costUsd: 0, toolCalls: 0, modelCalls: 0, unknownCostCalls: 0, ...json(r.spent, {}) },
			reserved: { tokens: 0, costUsd: 0, toolCalls: 0, modelCalls: 0, ...json(r.reserved, {}) },
		};
	const save = (b) =>
		store.run("UPDATE budgets SET spent = ?, reserved = ?, updated_at = ? WHERE id = ?", JSON.stringify(b.spent), JSON.stringify(b.reserved), new Date().toISOString(), b.id);

	const api = {
		create(missionId, limits = {}) {
			const id = newId("bud");
			store.run("INSERT INTO budgets (id, mission_id, limits, updated_at) VALUES (?, ?, ?, ?)", id, missionId, JSON.stringify({ ...DEFAULT_LIMITS, ...limits }), new Date().toISOString());
			return api.get(id);
		},
		get: (id) => row(store.get("SELECT * FROM budgets WHERE id = ?", id)),
		forMission: (missionId) => row(store.get("SELECT * FROM budgets WHERE mission_id = ? ORDER BY updated_at DESC LIMIT 1", missionId)),
		/** Which limit (if any) `amount` would exceed, counting reservations. */
		exceeds(b, amount) {
			for (const k of KEYS) {
				const lim = b.limits[k];
				if (lim === undefined || !amount[k]) continue;
				if (b.spent[k] + b.reserved[k] + amount[k] > lim) return k;
			}
			return undefined;
		},
		/** Reserve before work. Returns { ok, reservation } or { ok: false, limit }. */
		reserve(missionId, amount) {
			const b = api.forMission(missionId);
			if (!b) return { ok: true, reservation: null };
			const limit = api.exceeds(b, amount);
			if (limit) return { ok: false, limit, budget: b };
			for (const k of KEYS) b.reserved[k] += amount[k] ?? 0;
			save(b);
			return { ok: true, reservation: { budgetId: b.id, amount } };
		},
		/** Release a reservation and record actual use (cost undefined = unknown). */
		settle(reservation, actual) {
			if (!reservation) return;
			const b = api.get(reservation.budgetId);
			for (const k of KEYS) b.reserved[k] = Math.max(0, b.reserved[k] - (reservation.amount[k] ?? 0));
			api.addSpend(b, actual);
			save(b);
			return b;
		},
		/** Record use that was not reserved (e.g. a model turn reported after the fact). */
		record(missionId, actual) {
			const b = api.forMission(missionId);
			if (!b) return undefined;
			api.addSpend(b, actual);
			save(b);
			return b;
		},
		addSpend(b, actual = {}) {
			for (const k of ["tokens", "toolCalls", "modelCalls"]) b.spent[k] += actual[k] ?? 0;
			if (actual.costUsd === undefined || actual.costUsd === null) {
				if (actual.modelCalls) b.spent.unknownCostCalls += actual.modelCalls;
			} else b.spent.costUsd = Math.round((b.spent.costUsd + actual.costUsd) * 1e6) / 1e6;
		},
		/** Raise limits after the user explicitly extends a budget. */
		extend(missionId, factor = 2) {
			const b = api.forMission(missionId);
			if (!b) return undefined;
			for (const k of KEYS) if (b.limits[k] !== undefined) b.limits[k] = Math.ceil(b.limits[k] * factor * 100) / 100;
			store.run("UPDATE budgets SET limits = ? WHERE id = ?", JSON.stringify(b.limits), b.id);
			return api.get(b.id);
		},
		/** Plain-language summary for the UI; never shows an invented cost. */
		describe(b) {
			if (!b) return "";
			const cost = b.spent.unknownCostCalls && !b.spent.costUsd ? "cost unknown" : `$${b.spent.costUsd.toFixed(b.spent.costUsd < 0.1 ? 3 : 2)}${b.spent.unknownCostCalls ? "+ (some unknown)" : ""}`;
			return `${Math.round(b.spent.tokens / 1000)}k tokens · ${cost} · ${b.spent.toolCalls} actions`;
		},
	};
	return api;
}
