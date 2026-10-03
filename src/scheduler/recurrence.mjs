// Recurrence in the user's timezone (plan ch. 08, S01). Due times are stored in UTC; wall-clock schedules are
// computed in the IANA timezone with DST handled explicitly: a time that does not exist (spring forward) runs at
// the first valid instant after it, and an ambiguous time (fall back) runs once, at its first occurrence.

const fmtCache = new Map();
function wall(t, tz) {
	let f = fmtCache.get(tz);
	if (!f) {
		f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" });
		fmtCache.set(tz, f);
	}
	const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
	return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, min: +p.minute, s: +p.second, wd: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday) };
}
const offset = (t, tz) => {
	const w = wall(t, tz);
	return Date.UTC(w.y, w.m - 1, w.d, w.h, w.min, w.s) - Math.floor(t / 1000) * 1000;
};

/** UTC instant for a local wall time in `tz` (DST-safe as described above). */
export function zonedToUtc(y, m, d, h, min, tz) {
	const guess = Date.UTC(y, m - 1, d, h, min);
	const cands = [...new Set([guess - offset(guess - 86400000, tz), guess - offset(guess + 86400000, tz), guess - offset(guess, tz)])].sort((a, b) => a - b);
	const exact = cands.filter((t) => {
		const w = wall(t, tz);
		return w.y === y && w.m === m && w.d === d && w.h === h && w.min === min;
	});
	if (exact.length) return exact[0]; // ambiguous: first occurrence
	return guess - offset(guess - 86400000, tz); // nonexistent: shift forward by the gap
}

export const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/**
 * Next due instant strictly after `after` (ms).
 * @param {{ unit: "minutes"|"hours"|"days"|"weekdays", n: number, at?: string }} rec
 */
export function nextDue(rec, tz, after) {
	const n = Math.max(1, rec.n ?? 1);
	if (rec.unit === "minutes") return after + Math.max(5, n) * 60000;
	if (rec.unit === "hours") return after + n * 3600000;
	const [hh, mm] = (rec.at ?? "09:00").split(":").map(Number);
	let w = wall(after, tz);
	for (let i = 0; i < 400; i++) {
		const day = new Date(Date.UTC(w.y, w.m - 1, w.d + i));
		const t = zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hh, mm, tz);
		if (t <= after) continue;
		const wd = wall(t, tz).wd;
		if (rec.unit === "weekdays" && (wd === 0 || wd === 6)) continue;
		if (rec.unit === "days" && n > 1) {
			// every n days counted from the epoch day, so the cadence survives restarts
			const dayNo = Math.floor(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) / 86400000);
			if (dayNo % n !== 0) continue;
		}
		return t;
	}
	throw new Error("no next occurrence within a year");
}

/**
 * Missed runs after sleep or downtime: the default is ONE coalesced catch-up, not a burst.
 * Returns { due: [instants to run now], next }.
 */
export function catchUp(rec, tz, lastDue, now, policy = "coalesce") {
	if (lastDue === undefined || lastDue > now) return { due: [], next: lastDue ?? nextDue(rec, tz, now) };
	const next = nextDue(rec, tz, now);
	if (policy === "skip") return { due: [], next };
	return { due: [lastDue], next };
}
