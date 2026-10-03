// Standing authority (plan ch. 07). Grants are created only by trusted user events relayed by the shell
// (rule editor, plan approval, "Allow this routine", source selection). No model-facing tool can create,
// widen or extend one. A grant is matched at authorization and re-checked immediately before dispatch.
import { newId } from "../contracts/events.mjs";
import { EFFECTS } from "../contracts/domain.mjs";
import { json } from "../storage/db.mjs";
import { normalizeAddress, normalizePath } from "./canonical.mjs";

const TRUSTED_ORIGINS = new Set(["user:rule-editor", "user:plan-approval", "user:allow-routine", "user:sources", "user:onboarding"]);

export function createGrants(store) {
	const row = (r) =>
		r && {
			id: r.id,
			version: r.version,
			label: r.label,
			origin: r.origin,
			actionClasses: json(r.action_classes, []),
			account: r.account ?? undefined,
			roots: json(r.roots, []),
			destinations: json(r.destinations, []),
			limits: json(r.limits, {}),
			used: r.used,
			schedule: r.schedule ?? undefined,
			missionId: r.mission_id ?? undefined,
			expiresAt: r.expires_at ?? undefined,
			revokedAt: r.revoked_at ?? undefined,
			createdAt: r.created_at,
		};

	const api = {
		/** @param {string} origin must be a trusted user origin */
		create(draft, origin, now = new Date()) {
			if (!TRUSTED_ORIGINS.has(origin)) throw new Error(`grants can only come from a trusted user action (got ${origin})`);
			const classes = [...new Set(draft.actionClasses ?? [])];
			if (!classes.length || classes.some((c) => !EFFECTS[c])) throw new Error("grant needs known action classes");
			const id = newId("grant");
			const expiresAt = draft.expiresAt ?? (draft.expiresInDays ? new Date(now.getTime() + draft.expiresInDays * 86400000).toISOString() : null);
			store.run(
				"INSERT INTO grants (id, version, label, origin, action_classes, account, roots, destinations, limits, schedule, mission_id, expires_at, created_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				id,
				String(draft.label ?? classes.join(", ")).slice(0, 120),
				origin,
				JSON.stringify(classes),
				draft.account ?? null,
				JSON.stringify((draft.roots ?? []).map(normalizePath)),
				JSON.stringify((draft.destinations ?? []).map(normalizeDestination)),
				JSON.stringify(draft.limits ?? {}),
				draft.schedule ?? null,
				draft.missionId ?? null,
				expiresAt,
				now.toISOString(),
			);
			return api.get(id);
		},
		get: (id) => row(store.get("SELECT * FROM grants WHERE id = ?", id)),
		list({ includeInactive = false, now = new Date() } = {}) {
			const all = store.all("SELECT * FROM grants ORDER BY created_at DESC").map(row);
			return includeInactive ? all : all.filter((g) => isActive(g, now));
		},
		revoke(id, now = new Date()) {
			const r = store.run("UPDATE grants SET revoked_at = ?, version = version + 1 WHERE id = ? AND revoked_at IS NULL", now.toISOString(), id);
			return r.changes > 0;
		},
		revokeForMission(missionId, now = new Date()) {
			store.run("UPDATE grants SET revoked_at = ?, version = version + 1 WHERE mission_id = ? AND revoked_at IS NULL", now.toISOString(), missionId);
		},
		/** Count one use against a grant's quantity limit (inside the dispatch transaction). */
		use(id) {
			store.run("UPDATE grants SET used = used + 1 WHERE id = ?", id);
		},
		/** The first active grant that covers the request, or undefined. */
		match(request, now = new Date()) {
			for (const g of api.list({ now })) if (covers(g, request, now)) return g;
			return undefined;
		},
		/** Re-check a specific grant right before dispatch (revocation, expiry, version, limits). */
		stillCovers(grantId, version, request, now = new Date()) {
			const g = api.get(grantId);
			return !!g && g.version === version && isActive(g, now) && covers(g, request, now);
		},
	};
	return api;
}

export function normalizeDestination(d) {
	const s = String(d ?? "").trim();
	if (s.includes("@")) return normalizeAddress(s);
	try {
		return new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`).host.toLowerCase();
	} catch {
		return s.toLowerCase();
	}
}

function isActive(g, now) {
	if (g.revokedAt) return false;
	if (g.expiresAt && new Date(g.expiresAt) <= now) return false;
	if (g.limits?.maxActions !== undefined && g.used >= g.limits.maxActions) return false;
	return true;
}

export function within(root, p) {
	const r = normalizePath(root);
	const n = normalizePath(p);
	return n === r || n.startsWith(r.endsWith("\\") || r.endsWith("/") ? r : `${r}${process.platform === "win32" ? "\\" : "/"}`);
}

/**
 * @param {{ effect: string, missionId?: string, account?: string, paths?: string[], destinations?: string[], spendUsd?: number }} req
 */
export function covers(g, req, now = new Date()) {
	if (!g.actionClasses.includes(req.effect)) return false;
	if (g.missionId && g.missionId !== req.missionId) return false;
	if (g.account && normalizeAddress(g.account) !== normalizeAddress(req.account ?? "")) return false;
	if (g.roots.length && !(req.paths ?? []).every((p) => g.roots.some((r) => within(r, p)))) return false;
	if (g.roots.length && !(req.paths ?? []).length && req.effect.startsWith("local.")) return false;
	if (g.destinations.length) {
		const want = (req.destinations ?? []).map(normalizeDestination);
		if (!want.length || !want.every((d) => g.destinations.includes(d))) return false;
	}
	if (g.limits?.maxSpendUsd !== undefined && (req.spendUsd ?? 0) > g.limits.maxSpendUsd) return false;
	if (g.schedule && !inSchedule(g.schedule, now)) return false;
	return true;
}

/** "weekdays", "weekends", "daily", optionally with "HH:MM-HH:MM" (local time). */
export function inSchedule(spec, now = new Date()) {
	const s = spec.toLowerCase();
	const day = now.getDay();
	if (s.includes("weekdays") && (day === 0 || day === 6)) return false;
	if (s.includes("weekends") && day !== 0 && day !== 6) return false;
	const m = s.match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
	if (m) {
		const mins = now.getHours() * 60 + now.getMinutes();
		const a = +m[1] * 60 + +m[2];
		const b = +m[3] * 60 + +m[4];
		if (a <= b ? mins < a || mins > b : mins < a && mins > b) return false;
	}
	return true;
}
