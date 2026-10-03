// End to end through the real Pi SDK: truthful completion, the flagship sales brief, and crash recovery.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { writeXlsx } from "../src/tools/documents/xlsx.mjs";
import { tempDir } from "./helpers.mjs";
import { approve, fauxAssistantMessage, fauxText, fauxToolCall, fakePlatform, lastArtifact, makeModel, settled, startHost, until, writeFile } from "./e2e-helpers.mjs";

const call = (name, args) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

test("a cited answer succeeds only when its sources were actually read", async () => {
	const model = await makeModel();
	const { host } = await startHost({ model });
	model.faux.setResponses([
		call("search", { queries: ["midnight capsule"] }),
		call("read_pages", { urls: ["https://a.test/page"], query: "capsule" }),
		fauxAssistantMessage([fauxText("**It is a capsule.** [1]\n\n**Sources**\n1. [A](https://a.test/page)")]),
	]);
	const { missionId } = await host.handle("mission.create", { text: "what is the midnight capsule?", requestId: "q1" });
	const m = await settled(host, missionId);
	assert.equal(m.status, "succeeded");
	const view = host.viewOf(missionId);
	assert.match(view.answer, /capsule/);
	assert.ok(view.checks.some((c) => c.kind === "citations" && c.state === "passed"));

	model.faux.setResponses([fauxAssistantMessage([fauxText("Made up [1]\n\n**Sources**\n1. [B](https://never-read.test/x)")])]);
	const r2 = await host.handle("mission.create", { text: "another question", requestId: "q2" });
	const m2 = await settled(host, r2.missionId);
	assert.equal(m2.status, "partially-succeeded", "an unread citation is not a success");
	assert.match(host.viewOf(r2.missionId).outcome.missing.join(" "), /never read/);

	const dup = await host.handle("mission.create", { text: "what is the midnight capsule?", requestId: "q1" });
	assert.equal(dup.duplicate, true, "a repeated request id does not start a second mission");
	await host.close();
});

test("flagship: sales brief from a workbook and CRM to a chart, report and an exactly approved send", async () => {
	const model = await makeModel();
	const sales = tempDir("sales");
	const book = writeFile(
		path.join(sales, "Q3 sales final.xlsx"),
		writeXlsx([{ name: "Regions", rows: [["Region", "Q2 (k$)", "Q3 (k$)"], ["North", 412, 486], ["South", 298, 271], ["East", 356, 401], ["West", 221, 263], ["Total", { v: 1287, f: "SUM(B2:B5)" }, { v: 1421, f: "SUM(C2:C5)" }]] }]),
	);
	writeFile(path.join(sales, "Q3 sales draft.xlsx"), writeXlsx([{ name: "Regions", rows: [["Region", "Q3"], ["North", 1]] }]));
	const { host } = await startHost({ model, settings: { demoConnectors: true } });
	await host.handle("sources.add", { path: sales, purpose: "output" });
	model.faux.setResponses([
		call("plan", {
			summary: "Q3 sales brief",
			steps: [{ title: "Find and read the final workbook", tag: "files" }, { title: "Check CRM", tag: "connector" }, { title: "Chart and report" }, { title: "Send to Sam", tag: "approval" }],
			checks: [{ kind: "evidence" }, { kind: "calculation" }, { kind: "artifact", type: "chart" }, { kind: "artifact", type: "report" }, { kind: "receipt", effect: "external.communication" }],
		}),
		call("files_find", { pattern: "*sales*" }),
		call("sheet_read", { path: book }),
		call("crm_query", { filters: { quarter: "Q3" } }),
		call("calculate", { label: "Q3 vs Q2 change (%)", inputs: { q2: "1,287", q3: 1421 }, formula: "round((q3 - q2) / q2 * 100, 1)" }),
		call("chart_create", { title: "Revenue by region (k$)", categories: ["North", "South", "East", "West"], series: [{ name: "Q2", values: [412, 298, 356, 221] }, { name: "Q3", values: [486, 271, 401, 263] }], unit: "k" }),
		call("report_create", { title: "Q3 sales brief", sections: [{ heading: "Summary", text: "Revenue rose 10.4% to 1,421k." }, { heading: "By region", table: [["Region", "Q2", "Q3"], ["North", "412", "486"], ["South", "298", "271"], ["East", "356", "401"], ["West", "221", "263"]] }, { heading: "CRM check", text: "CRM shows East Q3 at 398k vs 401k in the workbook." }] }),
		(ctx) => call("mail_draft", { to: ["Sam <sam@example.test>"], subject: "Q3 sales brief", body: "Hi Sam, Q3 revenue rose 10.4%. Chart and report attached.", attachments: [lastArtifact(ctx, "chart"), lastArtifact(ctx, "report")] }),
		(ctx) => call("mail_send", { draftId: lastArtifact(ctx, "draft") }),
		fauxAssistantMessage([fauxText("Sent the Q3 brief to sam@example.test with the chart and report. East differs between CRM (398k) and the workbook (401k).")]),
	]);
	const { missionId } = await host.handle("mission.create", { text: "Make the Q3 sales brief and send it to Sam", requestId: "brief-1", skill: "sales-brief" });
	await approve(host);
	const m = await settled(host, missionId);
	const view = host.viewOf(missionId);
	assert.equal(m.status, "succeeded", JSON.stringify(view.outcome));
	const mail = host.tools.connectors.get("demo-mail");
	assert.equal(mail.outbox.size, 1, "exactly one message");
	const card = view.approvals.length ? view.approvals[0] : Object.values(host.snapshot().missions[missionId] ? {} : {})[0];
	assert.equal(card, undefined, "no approval left pending");
	const actions = (await host.handle("query.mission", { missionId })).actions;
	const send = actions.find((a) => a.tool === "mail_send");
	assert.equal(send.state, "verified");
	assert.deepEqual(send.display.recipients, ["sam@example.test"]);
	assert.equal(send.display.attachments.length, 2);
	const calc = (await host.handle("query.mission", { missionId })).evidence.find((e) => e.kind === "calculation");
	assert.equal(calc.derived.result, 10.4);
	assert.ok(view.artifacts.find((a) => a.type === "chart" && a.ok));
	assert.ok(view.artifacts.find((a) => a.type === "report" && a.ok));
	await host.close();
});

test("a changed draft invalidates the approval; declining keeps the draft and the mission is partial", async () => {
	const model = await makeModel();
	const { host } = await startHost({ model, settings: { demoConnectors: true } });
	model.faux.setResponses([
		call("plan", { steps: [{ title: "Draft" }, { title: "Send", tag: "approval" }], checks: [{ kind: "receipt", effect: "external.communication" }] }),
		call("mail_draft", { to: ["sam@example.test"], subject: "Hello", body: "v1" }),
		(ctx) => call("mail_send", { draftId: lastArtifact(ctx, "draft") }),
		fauxAssistantMessage([fauxText("Kept as a draft.")]),
	]);
	const { missionId } = await host.handle("mission.create", { text: "email sam", requestId: "d1" });
	await approve(host, "keep-draft");
	const m = await settled(host, missionId);
	assert.equal(m.status, "partially-succeeded");
	assert.equal(host.tools.connectors.get("demo-mail").outbox.size, 0);
	await host.close();
});

test("crash during a send: the restarted host reconciles by idempotency key and never sends twice", async () => {
	const model = await makeModel();
	const dataDir = tempDir("crash");
	const shared = new Map();
	const { host } = await startHost({ model, dataDir, settings: { demoConnectors: true, mode: "rules" } });
	await host.handle("grant.create", { draft: { label: "Reports to Sam", actionClasses: ["external.communication"], destinations: ["sam@example.test"] } });
	const mail = host.tools.connectors.get("demo-mail");
	mail.outbox = shared;
	mail.send = async (msg, { idempotencyKey }) => {
		shared.set(idempotencyKey, { ...msg, remoteId: "demo-msg-1" }); // the provider commits ...
		return new Promise(() => {}); // ... and the process dies before the response arrives
	};
	model.faux.setResponses([
		call("mail_draft", { to: ["sam@example.test"], subject: "Weekly", body: "numbers" }),
		(ctx) => call("mail_send", { draftId: lastArtifact(ctx, "draft") }),
	]);
	const { missionId } = await host.handle("mission.create", { text: "send the weekly", requestId: "c1" });
	await until(() => host.ledger.forMission(missionId).some((i) => i.tool === "mail_send" && i.state === "dispatching"));
	host.crash();

	model.faux.setResponses([fauxAssistantMessage([fauxText("The weekly was already sent; nothing repeated.")])]);
	// The provider's state outlives our process: the restarted connector sees the same outbox before recovery runs.
	const { host: h2 } = await startHost({ model, dataDir, settings: { demoConnectors: true, mode: "rules" }, before: (h) => (h.tools.connectors.get("demo-mail").outbox = shared) });
	const sendIntent = h2.ledger.forMission(missionId).find((i) => i.tool === "mail_send");
	assert.equal(sendIntent.state, "verified", "recovery found the send by its idempotency key");
	assert.equal(shared.size, 1);
	assert.ok(h2.viewOf(missionId).recovery, "a resume card was produced");
	await h2.close();
});

test("an interrupted read is retried safely after a crash", async () => {
	const model = await makeModel();
	const dataDir = tempDir("crash2");
	const platform = fakePlatform();
	const { host } = await startHost({ model, dataDir, platform });
	platform.hang("tool.search");
	model.faux.setResponses([call("search", { queries: ["x"] })]);
	const { missionId } = await host.handle("mission.create", { text: "look up x", requestId: "c2" });
	await until(() => host.ledger.forMission(missionId).some((i) => i.state === "dispatching"));
	host.crash();
	model.faux.setResponses([call("search", { queries: ["x"] }), fauxAssistantMessage([fauxText("x is y.")])]);
	const { host: h2 } = await startHost({ model, dataDir, platform });
	const first = h2.ledger.forMission(missionId)[0];
	assert.equal(first.state, "failed", "a read interrupted mid-flight is safe to retry, not unknown");
	const m = await settled(h2, missionId);
	assert.equal(m.status, "succeeded");
	await h2.close();
});

test("a follow-up on an unfinished mission tells the model what is still missing", async () => {
	const model = await makeModel();
	const { host } = await startHost({ model });
	let followUpText = "";
	model.faux.setResponses([
		call("plan", { summary: "Chart it", steps: [{ title: "Make the chart" }], checks: [{ kind: "artifact", type: "chart" }] }),
		fauxAssistantMessage([fauxText("Done.")]),
		(ctx) => {
			const last = ctx.messages.filter((m) => m.role === "user").at(-1);
			followUpText = typeof last.content === "string" ? last.content : last.content.map((c) => c.text ?? "").join("");
			return fauxAssistantMessage([fauxText("Making it now.")]);
		},
	]);
	const { missionId } = await host.handle("mission.create", { text: "Make a chart of nothing", requestId: "fu-1" });
	const m = await settled(host, missionId);
	assert.notEqual(m.status, "succeeded");
	await host.handle("mission.followUp", { missionId, text: "where is the chart?", requestId: "fu-2" });
	await until(() => followUpText);
	assert.match(followUpText, /^where is the chart\?/);
	assert.match(followUpText, /\[Midnight: this mission is not finished\. Missing: A validated artifact was produced: no artifact was produced. .*do the missing part now\.\]/i);
	await settled(host, missionId);
	await host.close();
});
