// Demo connectors backed by fixture data (plan ch. 12, 15): a paginated CRM with a deliberately conflicting record and
// a mail service that can fail before or after committing. They are clearly labeled as demo data, send nothing,
// and exist so the full flagship workflow and every failure path can be exercised without real accounts.

export const SALES_FIXTURE = {
	// thousands of dollars, the website walkthrough's sample figures (test fixtures, not business facts)
	Q2: { North: 412, South: 298, East: 356, West: 221 },
	Q3: { North: 486, South: 271, East: 401, West: 263 },
};

export function demoCrm({ records, pageSize = 3, failures = {} } = {}) {
	const data =
		records ??
		Object.entries(SALES_FIXTURE).flatMap(([quarter, regions], qi) =>
			Object.entries(regions).map(([region, amount], ri) => ({
				id: `deal-${quarter}-${region}`.toLowerCase(),
				region,
				quarter,
				amount: quarter === "Q3" && region === "East" ? 398 : amount, // the conflicting record: CRM says 398, the sheet 401
				stage: "closed-won",
				updatedAt: `2026-0${qi + 7}-28T17:00:00Z`,
			})),
		);
	let calls = 0;
	return {
		id: "demo-crm",
		kind: "crm",
		label: "Demo CRM (fixture data)",
		account: "demo@crm.example.test",
		version: "demo-1",
		demo: true,
		local: true,
		scopes: ["deals.read"],
		rateLimit: { perMinute: 120 },
		async query({ object = "deals", filters = {}, cursor = 0 }) {
			calls++;
			if (failures.transientOnce && calls === 1) throw Object.assign(new Error("CRM is busy"), { transient: true });
			if (object !== "deals") throw new Error(`unknown object ${object}`);
			const rows = data.filter((r) => Object.entries(filters).every(([k, v]) => String(r[k]).toLowerCase() === String(v).toLowerCase()));
			const page = rows.slice(cursor, cursor + pageSize);
			return { records: page, next: cursor + pageSize < rows.length ? cursor + pageSize : undefined, retrievedAt: new Date().toISOString() };
		},
	};
}

/**
 * failures: { mode: "none" | "lose-response" | "fail-before" }
 */
export function demoMail({ failures = { mode: "none" }, account = "you@demo.example.test" } = {}) {
	const outbox = new Map(); // idempotencyKey -> message
	return {
		id: "demo-mail",
		kind: "mail",
		label: "Demo mail (nothing is sent)",
		account,
		version: "demo-1",
		demo: true,
		local: true,
		idempotent: true,
		scopes: ["mail.send"],
		outbox,
		failures,
		async send(msg, { idempotencyKey }) {
			const box = this.outbox;
			if (failures.mode === "fail-before") throw new Error("mail service refused the message");
			if (box.has(idempotencyKey)) return { remoteId: box.get(idempotencyKey).remoteId, duplicate: true };
			const remoteId = `demo-msg-${box.size + 1}`;
			box.set(idempotencyKey, { ...msg, remoteId, at: new Date().toISOString() });
			if (failures.mode === "lose-response") throw Object.assign(new Error("connection reset after sending"), { code: "ECONNRESET", uncertain: true });
			return { remoteId };
		},
		async find(_args, { idempotencyKey }) {
			const m = this.outbox.get(idempotencyKey);
			return m ? { found: true, remoteId: m.remoteId } : { found: false };
		},
	};
}
