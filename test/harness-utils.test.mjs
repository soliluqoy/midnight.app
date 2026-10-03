import assert from "node:assert/strict";
import test from "node:test";
import { dedupeSearchRuns, pruneImages } from "../src/harness-utils.mjs";
import { chooseDefaultModel } from "../src/runtime/models.mjs";

const image = (size) => ({ type: "image", data: "x".repeat(size), mimeType: "image/jpeg" });

test("pruneImages keeps the newest screenshots and preserves surrounding tool text", () => {
	const messages = Array.from({ length: 6 }, (_, i) => ({
		role: "toolResult",
		content: [{ type: "text", text: `action ${i}` }, image(100)],
	}));
	const pruned = pruneImages(messages);

	assert.equal(pruned.filter((m) => m.content.some((part) => part.type === "image")).length, 3);
	assert.deepEqual(pruned.slice(0, 3).map((m) => m.content[1].text), Array(3).fill("[older screenshot removed]"));
	assert.deepEqual(pruned.slice(0, 3).map((m) => m.content[0].text), ["action 0", "action 1", "action 2"]);
	assert.equal(pruned[5].content[1].data.length, 100);
	assert.equal(messages[0].content[1].data.length, 100, "input is not mutated");
});

test("model routing prefers the configured fast vision model, then safe vision fallbacks", () => {
	const catalog = [
		{ provider: "anthropic", id: "claude", input: ["text", "image"], reasoning: true },
		{ provider: "openai-codex", id: "gpt-5.5", input: ["text", "image"], reasoning: true },
		{ provider: "openai", id: "gpt-6-luna", input: ["text", "image"], reasoning: false },
	];
	assert.equal(chooseDefaultModel(catalog).id, "gpt-6-luna");
	assert.equal(chooseDefaultModel(catalog.filter((m) => m.id !== "gpt-6-luna")).id, "gpt-5.5");
	assert.equal(chooseDefaultModel([{ provider: "x", id: "text", input: ["text"] }, { provider: "x", id: "vision", input: ["text", "image"] }]).id, "vision");
});

test("search routing removes duplicate URLs across related queries without changing query grouping", () => {
	const runs = dedupeSearchRuns([
		{ q: "one", engine: "google", results: [{ title: "A", url: "https://example.test/a#top" }, { title: "B", url: "https://example.test/b" }] },
		{ q: "two", engine: "google", results: [{ title: "A again", url: "https://example.test/a" }, { title: "C", url: "https://example.test/c" }] },
	]);
	assert.deepEqual(runs.map((r) => r.q), ["one", "two"]);
	assert.deepEqual(runs.map((r) => r.results.map((r) => r.title)), [["A", "B"], ["C"]]);
});

test("benchmark: stale screenshot pruning cuts the context image payload", () => {
	const messages = Array.from({ length: 12 }, (_, i) => ({ role: "toolResult", content: [image(80_000), { type: "text", text: `step ${i}` }] }));
	const before = JSON.stringify(messages).length;
	const after = JSON.stringify(pruneImages(messages)).length;
	const saved = 1 - after / before;
	assert.equal(pruneImages(messages).filter((m) => m.content.some((part) => part.type === "image")).length, 3);
	assert.ok(saved > 0.70, `expected >70% context reduction, got ${(saved * 100).toFixed(1)}%`);
	console.log(`screenshot context benchmark: ${before} -> ${after} serialized chars (${(saved * 100).toFixed(1)}% smaller)`);
});
