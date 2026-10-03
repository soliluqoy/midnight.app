// One grouped attention queue (plan ch. 07, S04). Suggestions say what changed, why it matters and what Midnight can
// prepare; they are deduplicated, cooled down per topic, held during quiet hours, and never expand the capsule or
// steal focus. Dismissals lower frequency; they never widen authority.
import { newId } from "../contracts/events.mjs";
import { json } from "../storage/db.mjs";

const inQuiet = (q, now) => {
	if (!q?.enabled) return false;
	const mins = now.getHours() * 60 + now.getMinutes();
	const [a, b] = [q.from, q.to].map((s) => {
		const [h, m] = String(s).split(":").map(Number);
		return h * 60 + (m || 0);
	});
	return a <= b ? mins >= a && mins < b : mins >= a || mins < b;
};

export function createAttention({ store, commit, emit, settings, onAction }) {
	const row = (r) => ({ id: r.id, dedupKey: r.dedup_key, group: r.group_key, missionId: r.mission_id ?? undefined, watchId: r.watch_id ?? undefined, severity: r.severity, title: r.title, reason: r.reason, evidence: json(r.evidence, []), suggested: r.suggested_action ?? undefined, status: r.status, createdAt: r.created_at, quietUntil: r.quiet_until ?? undefined });
	const api = {
		/** Returns the notification, or undefined if deduplicated or cooling down. */
		notify({ dedupKey, group = "", title, reason = "", severity = "info", missionId, watchId, evidence = [], suggested, cooldownMs = 30 * 60000, now = new Date() }) {
			const recent = store.get("SELECT created_at FROM notifications WHERE dedup_key = ? ORDER BY created_at DESC LIMIT 1", dedupKey);
			if (recent && now - new Date(recent.created_at) < cooldownMs) return undefined;
			const urgent = severity === "urgent" && (settings().urgentCategories ?? []).includes(group);
			const quiet = !urgent && inQuiet(settings().quietHours, now);
			const id = newId("ntf");
			return commit(() => {
				store.run(
					"INSERT INTO notifications (id, dedup_key, group_key, mission_id, watch_id, severity, title, reason, evidence, suggested_action, status, created_at, quiet_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
					id,
					dedupKey,
					group,
					missionId ?? null,
					watchId ?? null,
					severity,
					title.slice(0, 200),
					reason.slice(0, 1000),
					JSON.stringify(evidence),
					suggested ?? null,
					quiet ? "held" : "queued",
					now.toISOString(),
					quiet ? "quiet-hours" : null,
				);
				emit("notification.created", { missionId: missionId ?? "", payload: { id, title, reason, severity, watchId, status: quiet ? "held" : "queued", suggested, group } });
				return row(store.get("SELECT * FROM notifications WHERE id = ?", id));
			});
		},
		/** Release held notifications once quiet hours end. */
		releaseHeld(now = new Date()) {
			if (inQuiet(settings().quietHours, now)) return 0;
			const held = store.all("SELECT * FROM notifications WHERE status = 'held'");
			if (held.length)
				commit(() => {
					for (const h of held) {
						store.run("UPDATE notifications SET status = 'queued', quiet_until = NULL WHERE id = ?", h.id);
						emit("notification.updated", { missionId: h.mission_id ?? "", payload: { id: h.id, status: "queued" } });
					}
				});
			return held.length;
		},
		missionFinished(m, status, summary) {
			api.notify({ dedupKey: `mission:${m.id}:${status}`, group: m.watchId ? `watch:${m.watchId}` : "missions", title: `${m.title} · ${status === "succeeded" ? "ready" : status.replace("-", " ")}`, reason: summary, missionId: m.id, watchId: m.watchId, severity: status === "succeeded" ? "info" : "warn", suggested: "open" });
		},
		list: () => store.all("SELECT * FROM notifications WHERE status IN ('queued','held') ORDER BY created_at DESC LIMIT 100").map(row),
		act(id, action) {
			const n = store.get("SELECT * FROM notifications WHERE id = ?", id);
			if (!n) return { ok: false };
			const status = { do: "done", later: "later", "not-useful": "dismissed", never: "muted", dismiss: "dismissed" }[action];
			commit(() => {
				store.run("UPDATE notifications SET status = ?, acknowledged_at = ? WHERE id = ?", status, new Date().toISOString(), id);
				emit("notification.updated", { missionId: n.mission_id ?? "", payload: { id, status } });
			});
			onAction?.(row(n), action);
			return { ok: true, status };
		},
		inQuiet: (now = new Date()) => inQuiet(settings().quietHours, now),
	};
	return api;
}
