// Quiet watches (plan ch. 08, S01/S02). A watch is a durable subscription, not a running model turn: one
// nearest-deadline timer; each check is deterministic (a fingerprint of a folder listing, a page's text or connector
// records) and an unchanged check costs no model call and no notification. Material changes respect thresholds and
// cooldowns; missed runs coalesce into one catch-up; failures back off with jitter.
import { createHash } from "node:crypto";
import path from "node:path";
import { newId } from "../contracts/events.mjs";
import { json } from "../storage/db.mjs";
import { walk } from "../tools/files.mjs";
import { within } from "../policy/grants.mjs";
import { catchUp, localZone, nextDue } from "./recurrence.mjs";
import { PRIORITY } from "./queue.mjs";

const sha = (s) => `sha256:${createHash("sha256").update(s).digest("hex")}`;
const MAX_TIMER = 2 ** 31 - 1;

export function createWatches(d) {
	const { store, commit, emit, journal, roots, platform, connectors, attention, stop, settings, coord, now = () => Date.now() } = d;
	let timer;
	let running = false;
	let suspended = false;
	const counters = { checks: 0, unchanged: 0, changed: 0, modelCalls: 0 };

	const row = (r) =>
		r && {
			id: r.id,
			label: r.label,
			source: json(r.source, {}),
			recurrence: json(r.recurrence, {}),
			timezone: r.timezone,
			threshold: json(r.threshold, {}),
			cooldownS: r.cooldown_s,
			missedRun: r.missed_run,
			onChange: r.on_change,
			prompt: r.prompt ?? undefined,
			fingerprint: r.fingerprint ?? undefined,
			snapshotRef: r.snapshot_ref ?? undefined,
			nextDue: r.next_due ?? undefined,
			lastCheckAt: r.last_check_at ?? undefined,
			lastChangeAt: r.last_change_at ?? undefined,
			failures: r.failures,
			paused: !!r.paused,
			expiresAt: r.expires_at ?? undefined,
			createdAt: r.created_at,
		};
	const get = (id) => row(store.get("SELECT * FROM watches WHERE id = ?", id));
	const active = () => store.all("SELECT * FROM watches WHERE paused = 0").map(row).filter((w) => !w.expiresAt || new Date(w.expiresAt) > new Date(now()));

	function create(draft) {
		const src = draft.source;
		if (src.kind === "folder") {
			if (!src.path || !roots.list().some((r) => within(r.path, src.path))) throw new Error("a folder watch must be inside a folder you selected");
		} else if (src.kind === "url") {
			if (!/^https?:\/\//i.test(src.url ?? "")) throw new Error("a page watch needs an http(s) address");
		} else if (src.kind === "connector") {
			if (!connectors.get(src.connector ?? "")) throw new Error("that connector is not connected");
		}
		const id = newId("wch");
		const tz = localZone();
		const rec = draft.every;
		const due = nextDue(rec, tz, now());
		commit(() => {
			store.run(
				"INSERT INTO watches (id, label, source, recurrence, timezone, threshold, cooldown_s, on_change, prompt, next_due, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				id,
				draft.label,
				JSON.stringify(src),
				JSON.stringify(rec),
				tz,
				JSON.stringify(draft.threshold ?? {}),
				(draft.cooldownMinutes ?? 60) * 60,
				draft.onChange ?? "notify",
				draft.prompt ?? null,
				new Date(due).toISOString(),
				draft.expiresInDays ? new Date(now() + draft.expiresInDays * 86400000).toISOString() : null,
				new Date(now()).toISOString(),
			);
			emit("watch.checked", { payload: { watchId: id, created: true, nextDue: new Date(due).toISOString() } });
		});
		schedule();
		return get(id);
	}

	/** Deterministic observation: { fingerprint, snapshot, describe(prev) } */
	async function observe(w) {
		const s = w.source;
		if (s.kind === "folder") {
			const files = walk(s.path, { maxDepth: 3 }).map((f) => ({ p: path.relative(s.path, f.path), size: f.size, m: f.modified }));
			files.sort((a, b) => (a.p < b.p ? -1 : 1));
			return { fingerprint: sha(JSON.stringify(files)), snapshot: files };
		}
		if (s.kind === "url") {
			const pg = await platform.call("fetch.page", { url: s.url });
			const text = String(pg.text ?? "").replace(/\s+/g, " ").trim();
			return { fingerprint: sha(text), snapshot: { text: text.slice(0, 20000), title: pg.title } };
		}
		const c = connectors.get(s.connector);
		const records = [];
		let cursor = 0;
		for (let i = 0; cursor !== undefined && i < 50; i++) {
			const r = await connectors.call(c, "query", { ...(s.query ? JSON.parse(s.query) : {}), cursor });
			records.push(...r.records);
			cursor = r.next;
		}
		records.sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1));
		return { fingerprint: sha(JSON.stringify(records)), snapshot: records };
	}

	/** What changed between two snapshots, and whether it crosses the threshold. */
	function diff(w, prev, cur) {
		const t = w.threshold ?? {};
		if (w.source.kind === "folder") {
			const pm = new Map((prev ?? []).map((f) => [f.p, f]));
			const cm = new Map(cur.map((f) => [f.p, f]));
			const added = cur.filter((f) => !pm.has(f.p)).map((f) => f.p);
			const removed = (prev ?? []).filter((f) => !cm.has(f.p)).map((f) => f.p);
			const modified = cur.filter((f) => pm.has(f.p) && (pm.get(f.p).size !== f.size || pm.get(f.p).m !== f.m)).map((f) => f.p);
			const n = added.length + removed.length + modified.length;
			return { material: n >= (t.minChanges ?? 1), summary: [added.length && `${added.length} added (${added.slice(0, 3).join(", ")})`, removed.length && `${removed.length} removed`, modified.length && `${modified.length} changed (${modified.slice(0, 3).join(", ")})`].filter(Boolean).join("; ") };
		}
		if (w.source.kind === "url") return { material: true, summary: `the page changed${cur.title ? ` (“${cur.title}”)` : ""}` };
		const pm = new Map((prev ?? []).map((r) => [String(r.id), r]));
		const changes = [];
		for (const r of cur) {
			const p = pm.get(String(r.id));
			if (!p) changes.push({ id: r.id, kind: "new" });
			else if (t.field) {
				const a = Number(p[t.field]);
				const b = Number(r[t.field]);
				if (p[t.field] !== r[t.field] && (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(b - a) >= (t.minDelta ?? 0))) changes.push({ id: r.id, kind: "changed", field: t.field, from: p[t.field], to: r[t.field] });
			} else if (JSON.stringify(p) !== JSON.stringify(r)) changes.push({ id: r.id, kind: "changed" });
		}
		return { material: changes.length >= (t.minChanges ?? 1), summary: changes.slice(0, 5).map((c) => (c.kind === "new" ? `new ${c.id}` : c.field ? `${c.id} ${c.field} ${c.from} → ${c.to}` : `${c.id} changed`)).join("; ") };
	}

	async function check(w, { coalesced = false, dueAt } = {}) {
		const occ = `${w.id}@${dueAt ?? w.nextDue ?? new Date(now()).toISOString()}`;
		const inserted = store.run("INSERT OR IGNORE INTO occurrences (id, watch_id, due_at, started_at, coalesced) VALUES (?, ?, ?, ?, ?)", occ, w.id, dueAt ?? w.nextDue ?? new Date(now()).toISOString(), new Date(now()).toISOString(), coalesced ? 1 : 0);
		if (!inserted.changes) return { duplicate: true };
		counters.checks++;
		let obs;
		try {
			obs = await observe(w);
		} catch (err) {
			const failures = w.failures + 1;
			const backoff = Math.min(6 * 3600000, 60000 * 2 ** failures) * (0.85 + Math.random() * 0.3);
			commit(() => {
				store.run("UPDATE watches SET failures = ?, next_due = ?, last_check_at = ? WHERE id = ?", failures, new Date(now() + (err.retryAfterMs ?? backoff)).toISOString(), new Date(now()).toISOString(), w.id);
				store.run("UPDATE occurrences SET finished_at = ?, outcome = ? WHERE id = ?", new Date(now()).toISOString(), `error: ${String(err.message).slice(0, 200)}`, occ);
				emit("watch.checked", { payload: { watchId: w.id, error: String(err.message).slice(0, 200), failures } });
			});
			return { error: err.message };
		}
		const first = !w.fingerprint;
		const same = obs.fingerprint === w.fingerprint;
		const next = new Date(nextDue(w.recurrence, w.timezone, now())).toISOString();
		if (same || first) {
			counters.unchanged++;
			commit(() => {
				if (first) {
					const ref = journal.putPayload("", "watch-snapshot", obs.snapshot);
					store.run("UPDATE watches SET fingerprint = ?, snapshot_ref = ? WHERE id = ?", obs.fingerprint, ref, w.id);
				}
				store.run("UPDATE watches SET last_check_at = ?, next_due = ?, failures = 0 WHERE id = ?", new Date(now()).toISOString(), next, w.id);
				store.run("UPDATE occurrences SET finished_at = ?, outcome = ? WHERE id = ?", new Date(now()).toISOString(), first ? "baseline" : "unchanged", occ);
				emit("watch.checked", { payload: { watchId: w.id, changed: false, baseline: first, nextDue: next } });
			});
			return { changed: false, baseline: first };
		}
		const prev = w.snapshotRef ? JSON.parse(journal.getPayload(w.snapshotRef) ?? "null") : null;
		const dd = diff(w, prev, obs.snapshot);
		counters.changed++;
		const coolingDown = w.lastChangeAt && now() - new Date(w.lastChangeAt).getTime() < w.cooldownS * 1000;
		commit(() => {
			const ref = journal.putPayload("", "watch-snapshot", obs.snapshot);
			store.run("UPDATE watches SET fingerprint = ?, snapshot_ref = ?, last_check_at = ?, next_due = ?, failures = 0" + (dd.material ? ", last_change_at = ?" : "") + " WHERE id = ?", obs.fingerprint, ref, new Date(now()).toISOString(), next, ...(dd.material ? [new Date(now()).toISOString()] : []), w.id);
			store.run("UPDATE occurrences SET finished_at = ?, outcome = ? WHERE id = ?", new Date(now()).toISOString(), dd.material ? "changed" : "below threshold", occ);
			emit("watch.changed", { payload: { watchId: w.id, material: dd.material, summary: dd.summary, coolingDown: !!coolingDown } });
		});
		if (!dd.material || coolingDown) return { changed: true, material: dd.material, notified: false };
		attention.notify({ dedupKey: `watch:${w.id}:${obs.fingerprint}`, group: `watch:${w.id}`, title: `${w.label} changed`, reason: dd.summary, watchId: w.id, cooldownMs: w.cooldownS * 1000, suggested: w.onChange === "prepare" ? "prepare" : "open" });
		const mode = settings().mode;
		if (w.onChange === "prepare" && mode !== "ask" && !stop.proactivePaused()) {
			counters.modelCalls++;
			coord().createMission({
				text: `${w.prompt ?? `Something changed in ${w.label}. Prepare a short update for the user.`}\n\nWhat changed (from Midnight's deterministic check): ${dd.summary}`,
				requestId: `watch:${w.id}:${obs.fingerprint}`,
				trigger: { kind: "watch", watchId: w.id },
				watchId: w.id,
				priority: PRIORITY.routine,
				title: `${w.label}: update`,
			});
		}
		return { changed: true, material: true, notified: true };
	}

	async function tick() {
		if (running || suspended) return schedule();
		running = true;
		try {
			const t = now();
			for (const w of active()) {
				if (!w.nextDue || new Date(w.nextDue).getTime() > t) continue;
				await check(w).catch(() => {});
			}
			attention.releaseHeld();
		} finally {
			running = false;
			schedule();
		}
	}

	function schedule() {
		clearTimeout(timer);
		if (suspended) return;
		const due = active()
			.map((w) => (w.nextDue ? new Date(w.nextDue).getTime() : Number.POSITIVE_INFINITY))
			.reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY);
		const quietRelease = attention.inQuiet() ? 10 * 60000 : Number.POSITIVE_INFINITY;
		const wait = Math.min(due - now(), quietRelease);
		if (!Number.isFinite(wait)) return;
		timer = setTimeout(tick, Math.max(1000, Math.min(MAX_TIMER, wait)));
		timer.unref?.();
	}

	/** After downtime or sleep: one coalesced catch-up per overdue watch, then normal cadence. */
	async function coalesceMissed() {
		for (const w of active()) {
			const last = w.nextDue ? new Date(w.nextDue).getTime() : undefined;
			const { due, next } = catchUp(w.recurrence, w.timezone, last, now(), w.missedRun);
			if (due.length) await check(w, { coalesced: true, dueAt: new Date(due[0]).toISOString() }).catch(() => {});
			else if (last === undefined) commit(() => store.run("UPDATE watches SET next_due = ? WHERE id = ?", new Date(next).toISOString(), w.id));
		}
	}

	return {
		create,
		get,
		list: () => store.all("SELECT * FROM watches ORDER BY created_at").map(row).map((w) => ({ ...w, status: w.paused ? "paused" : `Watching; next check ${w.nextDue ? new Date(w.nextDue).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "soon"}` })),
		setPaused(id, paused) {
			commit(() => store.run("UPDATE watches SET paused = ?, next_due = ? WHERE id = ?", paused ? 1 : 0, paused ? null : new Date(nextDue(get(id).recurrence, get(id).timezone, now())).toISOString(), id));
			schedule();
			return get(id);
		},
		remove(id) {
			commit(() => store.run("DELETE FROM watches WHERE id = ?", id));
			schedule();
			return { ok: true };
		},
		check: (id, o) => check(get(id), o),
		coalesceMissed,
		counters: () => ({ ...counters }),
		summary() {
			const ws = active();
			const next = ws.map((w) => w.nextDue).filter(Boolean).sort()[0];
			return { count: ws.length, next };
		},
		async start() {
			await coalesceMissed();
			schedule();
		},
		stop() {
			clearTimeout(timer);
		},
		signal(s) {
			if (s.type === "suspend" || s.type === "lock-screen") {
				if (s.type === "suspend") {
					suspended = true;
					clearTimeout(timer);
				}
			} else if (s.type === "resume") {
				suspended = false;
				coalesceMissed().finally(schedule);
			}
		},
	};
}
