// The desktop-input lease (plan ch. 06, C02). One owner at a time, outside model control. Every grant raises the
// epoch; the input helper rejects commands carrying any other epoch, so a stale or hung worker cannot type after a
// takeover. Midnight holds the screen only for a short bounded action, never while waiting for the model; user
// takeover (Esc), lock, session switch or expiry revokes it at once. Background work never takes the screen from an
// active user.
export class LeaseBusyError extends Error {
	constructor(message, code = "BUSY") {
		super(message);
		this.code = code;
	}
}

/**
 * @param {{ now?: () => number, userIdleMs?: () => number, ttlMs?: number, onChange?: (holder) => void, arm?: (epoch) => Promise<any>, disarm?: () => Promise<any> }} o
 */
export function createScreenLease({ now = () => Date.now(), userIdleMs = () => Number.POSITIVE_INFINITY, ttlMs = 20000, onChange = () => {}, arm = async () => {}, disarm = async () => {} } = {}) {
	let epoch = 0;
	let holder = null; // { missionId, epoch, expiresAt, title }
	let revokedAt = 0;

	const expired = () => holder && holder.expiresAt <= now();
	const api = {
		/** @param {{ background?: boolean, title?: string }} o */
		async acquire(missionId, { background = false, title = "" } = {}) {
			if (expired()) await api.revokeAll("expired");
			if (holder && holder.missionId !== missionId) throw new LeaseBusyError(`the screen is in use by “${holder.title || "another mission"}”`);
			if (background && userIdleMs() < 5000) throw new LeaseBusyError("you are using the computer; background work waits for the screen", "USER_ACTIVE");
			if (holder?.missionId === missionId) {
				holder.expiresAt = now() + ttlMs;
				return { epoch: holder.epoch };
			}
			epoch += 1;
			holder = { missionId, epoch, expiresAt: now() + ttlMs, title };
			await arm(epoch);
			onChange({ ...holder });
			return { epoch };
		},
		heartbeat(missionId, e) {
			if (!holder || holder.missionId !== missionId || holder.epoch !== e) return false;
			holder.expiresAt = now() + ttlMs;
			return true;
		},
		async release(missionId, e) {
			if (!holder || holder.missionId !== missionId || (e !== undefined && holder.epoch !== e)) return false;
			holder = null;
			await disarm();
			onChange(null);
			return true;
		},
		/** Takeover, lock, session switch, emergency stop: revoke now. */
		async revokeAll(reason = "takeover") {
			const had = holder;
			epoch += 1; // invalidates anything issued before
			holder = null;
			revokedAt = now();
			await disarm();
			onChange(null, reason);
			return { revoked: !!had, reason };
		},
		/** True only for the live owner's current epoch. */
		valid: (missionId, e) => !!holder && !expired() && holder.missionId === missionId && holder.epoch === e,
		current: () => (holder && !expired() ? { ...holder } : null),
		epoch: () => epoch,
		revokedAt: () => revokedAt,
	};
	return api;
}
