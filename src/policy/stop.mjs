// Cancellation scopes (plan ch. 07, P04): pausing or cancelling one mission, pausing proactive work, and an
// emergency stop are separate controls. Once a stop is acknowledged the broker dispatches nothing new under it;
// an effect that was already delivered may finish, and its receipt says so.
export function createStopControl({ now = () => Date.now() } = {}) {
	let emergency;
	const missions = new Map(); // missionId -> "paused" | "cancelled"
	let proactivePaused = false;
	const listeners = new Set();
	const tell = (e) => {
		for (const l of listeners) l(e);
	};
	return {
		/** Revoke all dispatch authority immediately. Returns the acknowledgment time. */
		emergencyStop() {
			emergency = { at: now() };
			proactivePaused = true;
			tell({ type: "emergency", at: emergency.at });
			return emergency.at;
		},
		clearEmergency() {
			emergency = undefined;
			tell({ type: "clear" });
		},
		isEmergency: () => !!emergency,
		stopMission(missionId, reason) {
			missions.set(missionId, reason);
			tell({ type: "mission", missionId, reason });
		},
		clearMission(missionId) {
			missions.delete(missionId);
		},
		setProactivePaused(paused) {
			proactivePaused = paused;
			tell({ type: "proactive", paused });
		},
		proactivePaused: () => proactivePaused,
		blocked(missionId) {
			if (emergency) return "the emergency stop is on";
			const r = missions.get(missionId);
			return r ? `the mission was ${r}` : undefined;
		},
		subscribe(fn) {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
	};
}
