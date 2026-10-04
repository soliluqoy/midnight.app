import assert from "node:assert/strict";
import test from "node:test";
import { makeModel, startHost, settled, fauxAssistantMessage, fauxText } from "./e2e-helpers.mjs";
import { emptyProjection, reduce } from "../src/missions/projection.mjs";

test("dashboard updates carry watch changes and held notifications identify themselves", async () => {
	const model = await makeModel();
	const { host } = await startHost({ model, settings: { quietHours: { enabled: true, from: "22:00", to: "07:00" } } });
	const events = [];
	host.subscribe((e) => events.push(e));
	try {
		const watch = await host.handle("watch.create", { draft: { label: "Watch", source: { kind: "url", url: "https://example.invalid" }, every: { unit: "hours", n: 6 } } });
		assert.equal(events.at(-1).watching.count, 1);
		await host.handle("watch.setPaused", { watchId: watch.id, paused: true });
		assert.equal(events.at(-1).type, "watch.updated");
		assert.equal(events.at(-1).watching.count, 0);
		await host.handle("watch.setPaused", { watchId: watch.id, paused: false });
		assert.equal(events.at(-1).watching.count, 1);
		await host.handle("watch.delete", { watchId: watch.id });
		assert.equal(events.at(-1).type, "watch.deleted");
		assert.equal(events.at(-1).watching.count, 0);
		const held = host.tools.attention.notify({ dedupKey: "held", title: "Held", now: new Date(2026, 9, 4, 23) });
		assert.equal(host.snapshot().notifications[0].status, "held");
		assert.equal(events.at(-1).notifications[0].id, held.id);
		host.setSettings({ quietHours: { enabled: false } });
		const newest = host.tools.attention.notify({ dedupKey: "new", title: "New" });
		assert.equal(events.at(-1).notificationId, newest.id);
		assert.equal(events.at(-1).notifications.find((n) => n.id === events.at(-1).notificationId).title, "New");
	} finally { await host.close(); }
});

test("a follow-up failing before producing text never presents the previous answer as its result", async () => {
	const model = await makeModel();
	const { host } = await startHost({ model });
	try {
		model.faux.setResponses([fauxAssistantMessage([fauxText("First answer")])]);
		const { missionId } = await host.handle("mission.create", { text: "? First", requestId: "first" });
		await settled(host, missionId);
		assert.equal(host.viewOf(missionId).answer, "First answer");
		model.faux.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "Provider failed" })]);
		await host.handle("mission.followUp", { missionId, text: "? Next", requestId: "next" });
		await settled(host, missionId);
		const view = host.viewOf(missionId);
		assert.equal(view.lastInput, "? Next");
		assert.equal(view.answer, "");
		assert.match(view.outcome.summary, /Provider failed/);
	} finally { await host.close(); }
});

test("steering preserves the active run's answer and verification state", () => {
	let state = reduce(emptyProjection(), { seq: 1, type: "mission.created", missionId: "m", payload: { title: "Task" } });
	state = reduce(state, { seq: 2, type: "run.started", missionId: "m", runId: "r", payload: { input: "First" } });
	state = reduce(state, { seq: 3, type: "answer.recorded", missionId: "m", payload: { ref: "answer" } });
	state = reduce(state, { seq: 4, type: "run.started", missionId: "m", runId: "r", payload: { input: "Steering", steer: true } });
	assert.equal(state.missions.m.runs, 1);
	assert.equal(state.missions.m.answerRef, "answer");
});
