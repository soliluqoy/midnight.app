// Resource profiles and power awareness (plan ch. 09, G02/G03). Quiet collects events and runs authorized
// deterministic checks; Balanced allows bounded network work and one model task; Focused favors the active mission;
// Burst is a user-started, time-limited higher-concurrency mode. On battery, background work waits with a plain reason.
// Electron's thermal events are macOS-only, so no Windows "temperature" is claimed.
import { PRIORITY } from "../scheduler/queue.mjs";
import { unloadLocalModel } from "../runtime/models.mjs";

export const PROFILES = {
	quiet: { slots: { network: 1, inference: 1 }, allowBelow: PRIORITY.user, label: "Quiet" },
	balanced: { slots: { network: 2, inference: 1 }, allowBelow: PRIORITY.speculative, label: "Balanced" },
	focused: { slots: { network: 1, inference: 1 }, allowBelow: PRIORITY.timeSensitive, label: "Focused" },
	burst: { slots: { network: 4, inference: 1 }, allowBelow: PRIORITY.speculative, label: "Burst", minutes: 30 },
};

export function createResources({ queue, settings, fetchImpl }) {
	const power = { onBattery: false, locked: false, suspended: false, online: true };
	let burstUntil = 0;
	let profile = "balanced";

	const effective = () => (profile === "burst" && Date.now() > burstUntil ? "balanced" : profile);

	function gate(item) {
		const p = PROFILES[effective()] ?? PROFILES.balanced;
		if (power.suspended) return "Waiting for the computer to wake";
		if (!power.online && item.slot === "network") return "Waiting to reconnect";
		if (item.priority > p.allowBelow) return `${p.label} mode: background work waits`;
		if (power.onBattery && item.priority >= PRIORITY.routine) return "Waiting for power";
		return undefined;
	}

	const api = {
		apply(s = settings()) {
			profile = s.profile ?? "balanced";
			if (profile === "burst" && burstUntil < Date.now()) burstUntil = Date.now() + PROFILES.burst.minutes * 60000;
			const p = PROFILES[effective()] ?? PROFILES.balanced;
			queue.setSlots({ ...p.slots, ...(power.onBattery ? { network: Math.min(p.slots.network, 1) } : {}) });
			queue.setGate(gate);
			if (profile === "quiet") unloadLocalModel(s.local, fetchImpl).catch?.(() => {});
		},
		signal(s) {
			if (s.type === "on-battery") power.onBattery = true;
			else if (s.type === "on-ac") power.onBattery = false;
			else if (s.type === "lock-screen") power.locked = true;
			else if (s.type === "unlock-screen") power.locked = false;
			else if (s.type === "suspend") power.suspended = true;
			else if (s.type === "resume") power.suspended = false;
			else if (s.type === "online") power.online = s.online !== false;
			api.apply();
		},
		power: () => ({ ...power }),
		/** "Resource weather": why work is waiting, in plain words. */
		weather() {
			const p = PROFILES[effective()] ?? PROFILES.balanced;
			const st = queue.status();
			const reasons = [...new Set(st.waiting.map((w) => w.why).filter(Boolean))];
			return {
				profile: p.label,
				power: power.onBattery ? "on battery" : "plugged in",
				running: st.running.length,
				waiting: st.waiting.length,
				text: reasons[0] ?? (st.running.length ? `${st.running.length} mission${st.running.length > 1 ? "s" : ""} working` : "All quiet"),
				burstEndsAt: effective() === "burst" ? new Date(burstUntil).toISOString() : undefined,
			};
		},
	};
	return api;
}
