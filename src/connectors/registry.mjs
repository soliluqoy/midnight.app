// Connector registry (plan ch. 12). Each connector declares identity, version, account, scopes, effects,
// idempotency support and rate limits; MCP or vendor annotations are hints, never authority. A failed call never
// falls back to another account or a broader browser session.
export function createConnectorRegistry() {
	const byId = new Map();
	const buckets = new Map(); // account -> { tokens, at }

	function take(conn) {
		const per = conn.rateLimit?.perMinute;
		if (!per) return;
		const k = `${conn.id}:${conn.account ?? ""}`;
		const now = Date.now();
		const b = buckets.get(k) ?? { tokens: per, at: now };
		b.tokens = Math.min(per, b.tokens + ((now - b.at) / 60000) * per);
		b.at = now;
		if (b.tokens < 1) {
			buckets.set(k, b);
			throw Object.assign(new Error(`${conn.label} rate limit reached; retry in ${Math.ceil(((1 - b.tokens) / per) * 60)}s`), { code: "RATE_LIMIT", retryAfterMs: Math.ceil(((1 - b.tokens) / per) * 60000) });
		}
		b.tokens -= 1;
		buckets.set(k, b);
	}

	return {
		register(conn) {
			for (const k of ["id", "kind", "label", "version"]) if (!conn[k]) throw new Error(`connector needs ${k}`);
			byId.set(conn.id, conn);
			return conn;
		},
		unregister: (id) => byId.delete(id),
		get: (id) => byId.get(id),
		/** The connector of a kind: the one named, else the only one of that kind. Never guesses between accounts. */
		pick(kind, id) {
			if (id) {
				const c = byId.get(id);
				if (!c || c.kind !== kind) throw new Error(`no ${kind} connector ${id}`);
				return c;
			}
			const list = [...byId.values()].filter((c) => c.kind === kind);
			if (list.length > 1) throw new Error(`several ${kind} accounts are connected (${list.map((c) => c.id).join(", ")}); say which one`);
			return list[0];
		},
		list: (kind) => [...byId.values()].filter((c) => !kind || c.kind === kind).map((c) => ({ id: c.id, kind: c.kind, label: c.label, account: c.account, version: c.version, demo: !!c.demo, scopes: c.scopes ?? [], idempotent: !!c.idempotent })),
		/** Call an operation with rate limiting and bounded retry for reads only. */
		async call(conn, op, args, { signal, idempotencyKey } = {}) {
			const fn = conn[op];
			if (typeof fn !== "function") throw new Error(`${conn.label} cannot ${op}`);
			const read = op === "query" || op === "find";
			for (let attempt = 0; ; attempt++) {
				take(conn);
				try {
					return await fn.call(conn, args, { signal, idempotencyKey });
				} catch (err) {
					const transient = err?.code === "RATE_LIMIT" || err?.transient;
					if (!read || !transient || attempt >= 2 || signal?.aborted) throw err;
					await new Promise((r) => setTimeout(r, Math.min(err.retryAfterMs ?? 250 * 2 ** attempt, 4000)));
				}
			}
		},
	};
}
