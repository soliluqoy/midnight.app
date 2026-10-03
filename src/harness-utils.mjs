// Pure helpers shared by the desktop harness and its local evaluation tests.
// Keeping these out of Electron modules makes routing and context-budget behavior
// testable without starting a browser or a Windows input helper.

export const KEEP_IMAGES = 3;

/**
 * Keep only the newest screenshots in a conversation. Tool metadata and text are
 * retained so the model still knows what happened without paying for stale image
 * tokens on every subsequent turn.
 */
export function pruneImages(messages, keep = KEEP_IMAGES) {
	if (!Array.isArray(messages) || keep < 0) return messages;
	let seen = 0;
	const out = messages.slice();
	for (let i = out.length - 1; i >= 0; i--) {
		const message = out[i];
		if (message?.role !== "toolResult" || !Array.isArray(message.content) || !message.content.some((part) => part?.type === "image")) continue;
		if (++seen <= keep) continue;
		out[i] = {
			...message,
			content: message.content.map((part) => (part?.type === "image" ? { type: "text", text: "[older screenshot removed]" } : part)),
		};
	}
	return out;
}

/**
 * Search engines often return the same URL for several related queries. Keep the
 * first (usually highest-ranked) occurrence to avoid repeating snippets and URLs
 * in the model context.
 */
export function dedupeSearchRuns(runs, maxPerQuery = 8) {
	const seen = new Set();
	return (Array.isArray(runs) ? runs : []).map((run) => {
		const results = [];
		for (const result of run?.results ?? []) {
			const rawUrl = typeof result?.url === "string" ? result.url : "";
			const hash = rawUrl.indexOf("#");
			const key = hash < 0 ? rawUrl : rawUrl.slice(0, hash);
			if (!key || seen.has(key)) continue;
			seen.add(key);
			results.push(result);
			if (results.length >= maxPerQuery) break;
		}
		return { ...run, results };
	});
}
