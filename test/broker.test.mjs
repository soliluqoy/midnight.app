// P01-P04 acceptance: only trusted UI creates authority, exact approvals bind to the intent, revocation is
// re-checked at dispatch, uncertain effects are never blindly retried, and stops block new dispatch.
import assert from "node:assert/strict";
import test from "node:test";
import { callId, makeCore } from "./helpers.mjs";

const sent = [];
const mailSpec = (behavior = {}) => ({
	name: "mail_send",
	version: "1",
	label: "Send email",
	classify: (a) => ({
		effect: "external.communication",
		target: a.to.join(", "),
		account: "work@example.test",
		destinations: a.to,
		network: true,
		canonical: { to: [...a.to].map((x) => x.toLowerCase()).sort(), subject: a.subject, body: a.body },
		display: { title: `Send “${a.subject}”`, verb: "Send now", recipients: a.to },
	}),
	async execute(a, ctx) {
		if (behavior.lose) {
			sent.push({ ...a, key: ctx.idempotencyKey });
			throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
		}
		sent.push({ ...a, key: ctx.idempotencyKey });
		return { content: [{ type: "text", text: "sent" }], remoteId: `msg-${sent.length}` };
	},
	reconcile: behavior.reconcile,
});
const readSpec = {
	name: "search",
	label: "Search",
	classify: (a) => ({ effect: "read.web", target: a.q, network: true, canonical: a }),
	execute: async (a) => ({ content: [{ type: "text", text: `results for ${a.q}` }] }),
};

async function run(core, missionId, toolName, input) {
	const id = callId();
	const g = await core.broker.gate({ missionId, runId: "r1", toolCallId: id, toolName, input });
	if (g?.block) return { blocked: g.reason };
	return core.broker.execute({ missionId, runId: "r1", toolCallId: id, toolName, input });
}

test("reads run without prompts and leave a verified receipt", async () => {
	const core = await makeCore({ tools: [readSpec] });
	core.addMission("m1");
	const out = await run(core, "m1", "search", { q: "midnight" });
	assert.equal(out.content[0].text, "results for midnight");
	const [intent] = core.ledger.forMission("m1");
	assert.equal(intent.state, "verified");
	assert.equal(core.ledger.latestReceipt(intent.id).state, "verified");
	assert.equal(core.approvals.pending().length, 0);
	core.close();
});

test("an external send waits for an exact approval; a changed recipient is a new intent", async () => {
	sent.length = 0;
	const core = await makeCore({ tools: [mailSpec()] });
	core.addMission("m1");
	const p = run(core, "m1", "mail_send", { to: ["sam@example.test"], subject: "Q3", body: "hi" });
	await core.until(() => core.approvals.pending().length === 1);
	assert.equal(core.waits.at(-1).kind, "approval");
	const card = core.approvals.pending()[0].display;
	assert.deepEqual(card.recipients, ["sam@example.test"]);
	assert.equal(card.verb, "Send now");
	assert.equal(sent.length, 0, "nothing is sent before approval");
	assert.equal(core.approveLatest().ok, true);
	const out = await p;
	assert.equal(out.remoteId, "msg-1");
	assert.equal(sent.length, 1);
	// different recipient -> different intent -> new approval required
	const p2 = run(core, "m1", "mail_send", { to: ["boss@example.test"], subject: "Q3", body: "hi" });
	await core.until(() => core.approvals.pending().length === 1);
	assert.equal(sent.length, 1);
	core.approveLatest("decline");
	assert.match((await p2).blocked, /declined/);
	assert.equal(sent.length, 1);
	core.close();
});

test("an identical verified send is refused instead of repeated", async () => {
	sent.length = 0;
	const core = await makeCore({ tools: [mailSpec()] });
	core.addMission("m1");
	const args = { to: ["sam@example.test"], subject: "Q3", body: "hi" };
	const p = run(core, "m1", "mail_send", args);
	await core.until(() => core.approvals.pending().length === 1);
	core.approveLatest();
	await p;
	const again = await run(core, "m1", "mail_send", args);
	assert.match(again.blocked, /already happened/);
	assert.equal(sent.length, 1);
	core.close();
});

test("approval decisions must come from the displayed card and match the intent", async () => {
	const core = await makeCore({ tools: [mailSpec()] });
	core.addMission("m1");
	const p = run(core, "m1", "mail_send", { to: ["a@example.test"], subject: "s", body: "b" });
	await core.until(() => core.approvals.pending().length === 1);
	const a = core.approvals.pending()[0];
	assert.match(core.approvals.decide(a.id, { nonce: a.nonce, intentHash: a.intentHash, decision: "approve" }).error, /never displayed/);
	core.approvals.markDisplayed(a.id, a.nonce);
	assert.match(core.approvals.decide(a.id, { nonce: "forged", intentHash: a.intentHash, decision: "approve" }).error, /displayed card/);
	assert.match(core.approvals.decide(a.id, { nonce: a.nonce, intentHash: "sha256:other", decision: "approve" }).error, /changed/);
	assert.match((await p).blocked, /no longer matches/);
	core.close();
});

test("keep as draft and allow-this-routine", async () => {
	sent.length = 0;
	const core = await makeCore({ tools: [mailSpec()] });
	core.addMission("m1");
	const p = run(core, "m1", "mail_send", { to: ["a@example.test"], subject: "s", body: "b" });
	await core.until(() => core.approvals.pending().length === 1);
	core.approveLatest("keep-draft");
	assert.match((await p).blocked, /keep this as a draft/);
	const p2 = run(core, "m1", "mail_send", { to: ["a@example.test"], subject: "weekly", body: "b" });
	await core.until(() => core.approvals.pending().length === 1);
	core.approveLatest("allow-routine");
	await p2;
	assert.equal(core.grants.list().length, 1, "a scoped grant was created");
	// covered by the routine now: no new approval for the same recipient
	await run(core, "m1", "mail_send", { to: ["a@example.test"], subject: "weekly 2", body: "b" });
	assert.equal(core.approvals.pending().length, 0);
	assert.equal(sent.length, 2);
	// a new recipient is outside the routine
	const p4 = run(core, "m1", "mail_send", { to: ["new@example.test"], subject: "weekly 3", body: "b" });
	await core.until(() => core.approvals.pending().length === 1);
	core.approveLatest("decline");
	await p4;
	core.close();
});

test("grants: trusted origins only, scoped, expiring and revocable; revocation is rechecked at dispatch", async () => {
	sent.length = 0;
	const core = await makeCore({ tools: [mailSpec()] });
	core.addMission("m1");
	assert.throws(() => core.grants.create({ label: "x", actionClasses: ["external.communication"] }, "model"), /trusted/);
	const g = core.grants.create({ label: "report", actionClasses: ["external.communication"], destinations: ["Sam <SAM@example.test>"], account: "work@example.test", limits: { maxActions: 1 } }, "user:rule-editor");
	assert.ok(core.grants.match({ effect: "external.communication", account: "work@example.test", destinations: ["sam@example.test"] }));
	assert.equal(core.grants.match({ effect: "external.communication", account: "home@example.test", destinations: ["sam@example.test"] }), undefined);
	// revoke between gate (authorized by grant) and execute (dispatch)
	const id = callId();
	const input = { to: ["sam@example.test"], subject: "s", body: "b" };
	assert.equal(await core.broker.gate({ missionId: "m1", toolCallId: id, toolName: "mail_send", input }), undefined);
	core.grants.revoke(g.id);
	await assert.rejects(core.broker.execute({ missionId: "m1", toolCallId: id, toolName: "mail_send", input }), /revoked/);
	assert.equal(sent.length, 0);
	const expired = core.grants.create({ label: "old", actionClasses: ["read.connector"], expiresAt: "2000-01-01T00:00:00Z" }, "user:rule-editor");
	assert.equal(core.grants.match({ effect: "read.connector" })?.id, undefined, `${expired.id} is expired`);
	core.close();
});

test("a send whose response is lost is reconciled, never blindly retried", async () => {
	sent.length = 0;
	const core = await makeCore({ tools: [mailSpec({ lose: true, reconcile: async () => ({ state: "unknown" }) })] });
	core.addMission("m1", { mode: "rules" });
	core.grants.create({ label: "r", actionClasses: ["external.communication"], destinations: ["sam@example.test"] }, "user:rule-editor");
	const args = { to: ["sam@example.test"], subject: "s", body: "b" };
	await assert.rejects(run(core, "m1", "mail_send", args), /may have completed/);
	assert.equal(core.ledger.forMission("m1")[0].state, "unknown");
	const retry = await run(core, "m1", "mail_send", args);
	assert.match(retry.blocked, /may already have happened/);
	assert.equal(sent.length, 1, "exactly one attempt reached the service");
	core.close();
});

test("reconciliation can prove the lost send happened", async () => {
	sent.length = 0;
	const core = await makeCore({ tools: [mailSpec({ lose: true, reconcile: async (intent) => ({ state: "verified", remoteId: `found-${intent.idempotencyKey}` }) })] });
	core.addMission("m1");
	core.grants.create({ label: "r", actionClasses: ["external.communication"], destinations: ["sam@example.test"] }, "user:rule-editor");
	const out = await run(core, "m1", "mail_send", { to: ["sam@example.test"], subject: "s", body: "b" });
	assert.match(out.content[0].text, /confirmed it happened/);
	assert.equal(core.ledger.forMission("m1")[0].state, "verified");
	core.close();
});

test("emergency stop, mission stop, budget cap and offline privacy block new dispatch", async () => {
	const core = await makeCore({ tools: [readSpec] });
	core.addMission("m1");
	core.addMission("m2", { limits: { toolCalls: 1 } });
	core.addMission("m3", { privacy: "offline" });
	const t0 = Date.now();
	core.stop.emergencyStop();
	assert.ok(Date.now() - t0 < 250, "stop acknowledged within 250 ms");
	assert.match((await run(core, "m1", "search", { q: "x" })).blocked, /emergency stop/);
	core.stop.clearEmergency();
	core.stop.stopMission("m1", "paused");
	assert.match((await run(core, "m1", "search", { q: "x" })).blocked, /paused/);
	await run(core, "m2", "search", { q: "one" });
	await assert.rejects(run(core, "m2", "search", { q: "two" }), /budget/);
	assert.match((await run(core, "m3", "search", { q: "x" })).blocked, /offline/);
	core.close();
});

test("tools Midnight did not review need approval and are recorded as unverified", async () => {
	const core = await makeCore({ tools: [] });
	core.addMission("m1");
	const id = callId();
	const g = core.broker.gate({ missionId: "m1", toolCallId: id, toolName: "crm_update_deal", input: { id: 7, stage: "won" } });
	await core.until(() => core.approvals.pending().length === 1);
	core.approveLatest();
	assert.equal(await g, undefined);
	core.broker.foreignResult({ toolCallId: id, isError: false, content: [{ type: "text", text: "ok" }] });
	const [intent] = core.ledger.forMission("m1");
	assert.equal(intent.state, "acknowledged");
	core.close();
});

test("rehearsal runs authorization but not the effect", async () => {
	sent.length = 0;
	const core = await makeCore({ tools: [mailSpec()] });
	core.addMission("m1", { dryRun: true });
	core.grants.create({ label: "r", actionClasses: ["external.communication"], destinations: ["sam@example.test"] }, "user:rule-editor");
	const out = await run(core, "m1", "mail_send", { to: ["sam@example.test"], subject: "s", body: "b" });
	assert.match(out.content[0].text, /rehearsal/);
	assert.equal(sent.length, 0);
	core.close();
});

test("writes to the same file serialize; reads share", async () => {
	const order = [];
	const writeSpec = {
		name: "write",
		label: "Write",
		classify: (a) => ({ effect: "artifact.stage", target: a.f, canonical: a, resources: [{ key: `file:${a.f}`, mode: "write" }] }),
		async execute(a) {
			order.push(`start ${a.n}`);
			await new Promise((r) => setTimeout(r, 30));
			order.push(`end ${a.n}`);
			return { content: [] };
		},
	};
	const core = await makeCore({ tools: [writeSpec] });
	core.addMission("m1");
	core.addMission("m2");
	await Promise.all([run(core, "m1", "write", { f: "x", n: 1 }), run(core, "m2", "write", { f: "x", n: 2 })]);
	assert.deepEqual(order.map((s) => s.split(" ")[0]), ["start", "end", "start", "end"]);
	core.close();
});
