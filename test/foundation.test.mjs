// Phase 1 foundation: storage migrations/backup, IPC contract validation, plan checks, projection replay and
// the document layer (ZIP limits, XLSX, DOCX round trips).
import assert from "node:assert/strict";
import zlib from "node:zlib";
import test from "node:test";
import { validateRequest } from "../src/contracts/ipc.mjs";
import { makeEvent } from "../src/contracts/events.mjs";
import { evaluateChecks, normalizePlan, outcomeOf } from "../src/missions/plan.mjs";
import { emptyProjection, reduceAll } from "../src/missions/projection.mjs";
import { openStore, restoreBackup, StorageLockedError } from "../src/storage/db.mjs";
import { readDocx, validateDocx, writeDocx } from "../src/tools/documents/docx.mjs";
import { readXlsx, sheetRange, updateCells, writeXlsx } from "../src/tools/documents/xlsx.mjs";
import { ArchiveError, readZip, writeZip } from "../src/tools/documents/zip.mjs";
import { tempDir } from "./helpers.mjs";

test("storage: single owner, migrations, consistent backup and restore", async () => {
	const dir = tempDir();
	const s = await openStore(dir);
	assert.equal(s.schema, 1);
	await assert.rejects(openStore(dir), StorageLockedError);
	s.meta("probe", "before");
	const file = await s.backup();
	s.meta("probe", "after");
	s.close();
	restoreBackup(dir, file);
	const s2 = await openStore(dir);
	assert.equal(s2.meta("probe"), "before");
	s2.close();
});

test("IPC: unknown methods, bad versions, replays, oversize and bad params are rejected", () => {
	assert.equal(validateRequest({ v: 1, seq: 1, method: "mission.create", params: { text: "hi", requestId: "r1" } }).ok, true);
	assert.match(validateRequest({ v: 2, seq: 1, method: "mission.create", params: {} }).error, /version/);
	assert.match(validateRequest({ v: 1, seq: 1, method: "shell.exec", params: {} }).error, /unknown method/);
	assert.match(validateRequest({ v: 1, seq: 1, method: "mission.create", params: { text: "hi", requestId: "r1" } }, { lastSeq: 5 }).error, /replayed/);
	assert.match(validateRequest({ v: 1, seq: 9, method: "mission.create", params: { text: "x".repeat(70000), requestId: "r" } }).error, /too large/);
	assert.match(validateRequest({ v: 1, seq: 9, method: "grant.revoke", params: { grantId: "../../x" } }).error, /invalid params/);
});

test("plans: success needs every check; answers alone are not success for a task", () => {
	const plan = normalizePlan({ steps: [{ title: "Read" }, { title: "Chart", checks: [{ kind: "artifact", type: "chart" }] }], checks: [{ kind: "calculation" }] });
	assert.deepEqual(plan.checks.map((c) => c.kind).sort(), ["answer", "artifact", "calculation"]);
	const facts = { answer: "Done.", artifacts: [], receipts: [], evidence: 0, calculations: 1, retrievedUrls: new Set() };
	assert.equal(outcomeOf(evaluateChecks(plan.checks, facts)), "partially-succeeded");
	facts.artifacts = [{ type: "chart", validation: { ok: true } }];
	assert.equal(outcomeOf(evaluateChecks(plan.checks, facts)), "succeeded");
	const cite = evaluateChecks([{ id: "c1", kind: "citations", params: {}, required: true }], { answer: "See [x](https://a.test/p)", retrievedUrls: new Set() });
	assert.equal(cite[0].state, "failed");
	assert.throws(() => normalizePlan({ steps: [{ title: "x", checks: [{ kind: "vibes" }] }] }), /unknown check/);
});

test("projection: snapshot plus replay equals full replay", () => {
	const ev = (seq, type, payload) => ({ ...makeEvent(type, { missionId: "m1", payload }), seq });
	const events = [
		ev(1, "mission.created", { title: "Q3", goal: "Q3 brief" }),
		ev(2, "mission.state", { from: "draft", to: "running" }),
		ev(3, "plan.revised", { revision: 1, nodes: [{ id: "n1", title: "Read" }], checks: [] }),
		ev(4, "action.prepared", { intentId: "a1", tool: "search", effect: "read.web", target: "https://example.test" }),
		ev(5, "action.reconciled", { intentId: "a1", state: "verified" }),
		ev(6, "mission.completed", { status: "succeeded", summary: "ok" }),
	];
	const full = reduceAll(emptyProjection(), events);
	const snap = reduceAll(emptyProjection(), events.slice(0, 3));
	assert.deepEqual(reduceAll(snap, events.slice(3)), full);
	assert.deepEqual(reduceAll(full, events), full, "replaying old events is a no-op");
	assert.equal(full.missions.m1.outcome.status, "succeeded");
});

test("documents: zip limits stop bombs; xlsx and docx round-trip", () => {
	const z = writeZip([{ name: "a.txt", data: "hello ".repeat(100) }]);
	assert.match(readZip(z).text("a.txt"), /^hello/);
	const bomb = writeZip([{ name: "b.bin", data: Buffer.alloc(2_000_000) }]);
	assert.throws(() => readZip(bomb), ArchiveError);
	assert.ok(zlib.crc32);

	const book = writeXlsx([{ name: "Q3", rows: [["Region", "Q2", "Q3"], ["North", 412, 486], ["South", 298, 271], ["Total", { v: 710, f: "SUM(B2:B3)" }, { v: 757, f: "SUM(C2:C3)" }]] }]);
	const parsed = readXlsx(book);
	const sheet = parsed.sheets[0];
	assert.equal(sheet.cells.get("B2").v, 412);
	assert.equal(sheet.cells.get("B4").f, "SUM(B2:B3)");
	assert.equal(sheetRange(sheet, "A1:C2").rows[1].cells[2].v, 486);
	const { buffer, changed } = updateCells(book, "Q3", { C3: 280 });
	assert.deepEqual(changed, ["C3"]);
	const after = readXlsx(buffer).sheets[0];
	assert.equal(after.cells.get("C3").v, 280);
	assert.equal(after.cells.get("B4").f, "SUM(B2:B3)", "non-target formulas preserved");

	const doc = { title: "Q3 sales brief", footer: "midnight", blocks: [{ type: "heading", level: 1, text: "Summary" }, { type: "p", text: "Revenue **rose**." }, { type: "table", rows: [["Region", "Q3"], ["North", "486"]] }] };
	const docx = writeDocx(doc);
	assert.equal(validateDocx(docx, doc).ok, true);
	assert.equal(readDocx(docx).blocks.find((b) => b.type === "heading" && b.level === 1).text, "Summary");
});
