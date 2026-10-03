// Bounded mission concurrency (plan ch. 08, C01). Direct user work first, then time-sensitive authorized work,
// routine preparation, then speculative work. Waiting items age upward so nothing starves forever. Slot counts
// are tuning defaults, not promises: two network/I/O missions and one local-inference mission at a time.
export const PRIORITY = { user: 0, timeSensitive: 1, routine: 2, speculative: 3 };

export function createQueue({ start, slots = { network: 2, inference: 1 }, agingMs = 5 * 60 * 1000, now = () => Date.now() }) {
	const waiting = [];
	const running = new Map(); // missionId -> slot
	let gate = () => undefined; // (item) -> reason it must wait, or undefined
	const reasons = new Map(); // missionId -> why it is still waiting

	const effective = (it) => it.priority - Math.floor((now() - it.enqueuedAt) / agingMs);
	const used = (slot) => [...running.values()].filter((s) => s === slot).length;

	function pump() {
		waiting.sort((a, b) => effective(a) - effective(b) || a.enqueuedAt - b.enqueuedAt);
		for (let i = 0; i < waiting.length; ) {
			const it = waiting[i];
			const slot = it.slot ?? "network";
			const why = gate(it) ?? (used(slot) >= (slots[slot] ?? 1) ? `queued behind ${used(slot) === 1 ? "another mission" : `${used(slot)} missions`}` : undefined);
			if (why) {
				reasons.set(it.missionId, why);
				i++;
				continue;
			}
			waiting.splice(i, 1);
			reasons.delete(it.missionId);
			running.set(it.missionId, slot);
			Promise.resolve()
				.then(() => start(it))
				.catch(() => {})
				.finally(() => {});
		}
	}

	return {
		/** @param {{ missionId: string, priority?: number, slot?: "network"|"inference", speculative?: boolean }} item */
		enqueue(item) {
			if (running.has(item.missionId) || waiting.some((w) => w.missionId === item.missionId)) return false;
			waiting.push({ priority: PRIORITY.user, ...item, enqueuedAt: now() });
			pump();
			return true;
		},
		done(missionId) {
			running.delete(missionId);
			pump();
		},
		remove(missionId) {
			const i = waiting.findIndex((w) => w.missionId === missionId);
			if (i >= 0) waiting.splice(i, 1);
			reasons.delete(missionId);
		},
		setGate(fn) {
			gate = fn;
			pump();
		},
		setSlots(next) {
			Object.assign(slots, next);
			pump();
		},
		pump,
		isRunning: (missionId) => running.has(missionId),
		isWaiting: (missionId) => waiting.some((w) => w.missionId === missionId),
		why: (missionId) => reasons.get(missionId),
		status: () => ({ running: [...running.keys()], waiting: waiting.map((w) => ({ missionId: w.missionId, priority: w.priority, why: reasons.get(w.missionId) })) }),
	};
}
