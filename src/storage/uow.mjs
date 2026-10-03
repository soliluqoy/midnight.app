// Unit of work: storage writes and journal events commit together; listeners hear events only after COMMIT.
import { makeEvent } from "../contracts/events.mjs";

export function createUnitOfWork(store, journal) {
	let depth = 0;
	const commit = (fn) => {
		depth++;
		try {
			const out = store.tx(fn);
			depth--;
			if (depth === 0) journal.commit();
			return out;
		} catch (err) {
			depth--;
			if (depth === 0) journal.rollback();
			throw err;
		}
	};
	/** Append a domain event (call inside commit()). */
	const emit = (type, fields) => journal.append(makeEvent(type, fields));
	return { commit, emit };
}
