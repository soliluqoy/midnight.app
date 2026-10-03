// The MidnightEvent envelope (plan ch. 05). Sequence numbers are assigned by the journal when an event is stored;
// `id` and `correlationId` are stable across replays so the renderer and tests can deduplicate.
import { randomUUID } from "node:crypto";
import { EVENT_TYPES, SCHEMA_VERSION } from "./domain.mjs";

const KNOWN = new Set(EVENT_TYPES);

/**
 * @param {string} type one of EVENT_TYPES
 * @param {{ missionId?: string, runId?: string, correlationId?: string, payload?: object, at?: string }} fields
 */
export function makeEvent(type, { missionId = "", runId, correlationId, payload = {}, at } = {}) {
	if (!KNOWN.has(type)) throw new Error(`unknown event type ${type}`);
	const id = randomUUID();
	return {
		schemaVersion: SCHEMA_VERSION,
		id,
		seq: 0,
		missionId,
		runId,
		occurredAt: at ?? new Date().toISOString(),
		type,
		correlationId: correlationId ?? id,
		payload,
	};
}

export const newId = (prefix) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
