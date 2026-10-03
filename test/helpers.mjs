// Shared fixtures for headless tests: a real SQLite store in a temp folder and the policy core around it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApprovals } from "../src/policy/approvals.mjs";
import { createBroker } from "../src/policy/broker.mjs";
import { createGrants } from "../src/policy/grants.mjs";
import { createLedger } from "../src/policy/ledger.mjs";
import { createLocks } from "../src/policy/locks.mjs";
import { createRoots } from "../src/policy/roots.mjs";
import { createStopControl } from "../src/policy/stop.mjs";
import { createBudgets } from "../src/resources/budget.mjs";
import { openStore } from "../src/storage/db.mjs";
import { createJournal } from "../src/storage/journal.mjs";
import { createUnitOfWork } from "../src/storage/uow.mjs";

export function tempDir(name = "midnight-test") {
	return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

export async function openTestStore(dir = tempDir()) {
	return openStore(dir);
}

/** The policy core with an in-memory mission table, for broker tests. */
export async function makeCore({ tools = [], platform } = {}) {
	const dir = tempDir();
	const store = await openStore(dir);
	const journal = createJournal(store);
	const { commit, emit } = createUnitOfWork(store, journal);
	const ledger = createLedger(store, { runtimeVersion: "test" });
	const grants = createGrants(store);
	const approvals = createApprovals(store);
	const budgets = createBudgets(store);
	const locks = createLocks();
	const stop = createStopControl();
	const roots = createRoots(store);
	const missionMap = new Map();
	const missions = { get: (id) => missionMap.get(id) };
	const toolMap = new Map(tools.map((t) => [t.name, t]));
	const waits = [];
	const events = [];
	journal.subscribe((e) => events.push(e));
	const broker = createBroker({
		commit,
		emit,
		ledger,
		grants,
		approvals,
		budgets,
		locks,
		stop,
		missions,
		roots,
		tools: toolMap,
		journal,
		platform: platform ?? { lease: { acquire: async () => ({ epoch: 1, release() {} }) } },
		hooks: { waiting: (m, kind, info) => waits.push({ m, kind, info }), resumed: () => {}, reconcileNeeded: () => {} },
	});
	const addMission = (id, fields = {}) => {
		const m = { id, mode: "ask", privacy: "cloud", status: "running", ...fields };
		missionMap.set(id, m);
		budgets.create(id, fields.limits);
		return m;
	};
	/** Approve the newest pending approval as the trusted UI would. */
	const approveLatest = (decision = "approve") => {
		const a = approvals.pending().at(-1);
		approvals.markDisplayed(a.id, a.nonce);
		return approvals.decide(a.id, { nonce: a.nonce, intentHash: a.intentHash, decision });
	};
	const until = async (fn, ms = 2000) => {
		const t = Date.now();
		while (!fn()) {
			if (Date.now() - t > ms) throw new Error("timed out waiting for condition");
			await new Promise((r) => setTimeout(r, 5));
		}
	};
	return { dir, store, journal, commit, emit, ledger, grants, approvals, budgets, locks, stop, roots, missions: missionMap, broker, addMission, approveLatest, until, waits, events, close: () => store.close() };
}

let n = 0;
export const callId = () => `call-${++n}`;
