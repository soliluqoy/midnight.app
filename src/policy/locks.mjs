// Per-resource arbitration (plan ch. 06, C03): shared read / exclusive write locks on canonical resource keys,
// always acquired in sorted order so two missions cannot deadlock, with a timeout instead of waiting forever.
export function createLocks() {
	const held = new Map(); // key -> { mode, owners: Set, queue: [] }

	function tryTake(key, mode, owner) {
		let s = held.get(key);
		if (!s) {
			s = { mode, owners: new Set(), queue: [] };
			held.set(key, s);
		}
		if (s.owners.size === 0) {
			s.mode = mode;
			s.owners.add(owner);
			return true;
		}
		if (s.owners.has(owner)) return true;
		if (mode === "read" && s.mode === "read" && !s.queue.some((q) => q.mode === "write")) {
			s.owners.add(owner);
			return true;
		}
		return false;
	}

	function release(key, owner) {
		const s = held.get(key);
		if (!s) return;
		s.owners.delete(owner);
		while (s.owners.size === 0 && s.queue.length) {
			const next = s.queue.shift();
			if (tryTake(key, next.mode, next.owner)) next.resolve();
			if (next.mode === "write") break;
			while (s.queue[0]?.mode === "read" && tryTake(key, "read", s.queue[0].owner)) s.queue.shift().resolve();
		}
		if (s.owners.size === 0 && !s.queue.length) held.delete(key);
	}

	return {
		/**
		 * Acquire all `resources` ([{ key, mode: "read" | "write" }]) for `owner`, in canonical order.
		 * Resolves to a release function; rejects with a conflict error after `timeoutMs`.
		 */
		async acquire(resources, owner, { timeoutMs = 30000, signal } = {}) {
			const wanted = [...new Map(resources.map((r) => [r.key, r])).values()].sort((a, b) => (a.key < b.key ? -1 : 1));
			const got = [];
			try {
				for (const r of wanted) {
					if (!tryTake(r.key, r.mode, owner)) {
						await new Promise((resolve, reject) => {
							const entry = { mode: r.mode, owner, resolve: () => (clearTimeout(t), resolve()) };
							const t = setTimeout(() => {
								const s = held.get(r.key);
								if (s) s.queue = s.queue.filter((q) => q !== entry);
								reject(Object.assign(new Error(`${r.key} is in use by another mission`), { code: "CONFLICT" }));
							}, timeoutMs);
							signal?.addEventListener("abort", () => (clearTimeout(t), reject(new Error("aborted"))), { once: true });
							held.get(r.key).queue.push(entry);
						});
					}
					got.push(r.key);
				}
			} catch (err) {
				for (const k of got) release(k, owner);
				throw err;
			}
			return () => {
				for (const k of got) release(k, owner);
			};
		},
		holders: (key) => [...(held.get(key)?.owners ?? [])],
	};
}
