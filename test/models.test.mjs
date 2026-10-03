// Model routing (M01): quick answers keep the chosen model; tasks get the task model or, from the fast default, a
// stronger one; a model the user picked on purpose is never overridden automatically.
import assert from "node:assert/strict";
import test from "node:test";
import { routeModel } from "../src/runtime/models.mjs";

const M = (provider, id) => ({ provider, id, input: ["text", "image"], reasoning: true });
const runtime = (avail) => ({
	getAvailable: async () => avail,
	getModel: (p, id) => avail.find((m) => m.provider === p && m.id === id),
	checkAuth: async () => undefined,
});
const rt = runtime([M("openai-codex", "gpt-6-luna"), M("openai-codex", "gpt-6.1-sol"), M("anthropic", "claude-opus-5-5")]);
const pick = async (settings, kind) => (await routeModel(rt, settings, "cloud", kind)).route;

test("routing: tasks move off the fast default; quick answers, explicit task models and deliberate choices are respected", async () => {
	const luna = { provider: "openai-codex", model: "gpt-6-luna" };
	assert.equal((await pick(luna, "quick")).model, "gpt-6-luna");
	assert.deepEqual(await pick(luna, "task"), { provider: "openai-codex", model: "gpt-6.1-sol", privacy: "cloud", reason: "stronger model for tasks" });
	assert.equal((await pick({ ...luna, taskModel: "anthropic|claude-opus-5-5" }, "task")).model, "claude-opus-5-5");
	assert.equal((await pick({ provider: "anthropic", model: "claude-opus-5-5" }, "task")).model, "claude-opus-5-5", "a non-default choice is kept");
	assert.equal((await pick({ ...luna, taskModel: "gone|nope" }, "task")).model, "gpt-6-luna", "an unusable task model falls back to the chosen one");
	const noSol = runtime([M("openai-codex", "gpt-6-luna")]);
	assert.equal((await routeModel(noSol, luna, "cloud", "task")).route.model, "gpt-6-luna");
});
