// Model routing by capability and privacy (plan ch. 10, M01/M02). The privacy profile travels with the mission:
// a local or offline mission only ever uses a local endpoint, and never escalates to a cloud model because the
// local one struggled. Supporting an endpoint is not proof it can use tools or see images; the capability matrix
// records what was actually configured and measured.

export const LOCAL_PROVIDER = "local";

// Luna when the catalog has it, then the older default, then any capable vision model.
const PREFERRED = "gpt-6-luna";
const FALLBACK = "gpt-5.5";
// Tasks (plans, computer use, research) go to a stronger model when the chosen one is the fast default.
const STRONG = "gpt-6.1-sol";
const isOpenAI = (m) => m.provider === "openai" || m.provider === "openai-codex";

export class NoLocalModelError extends Error {}
export class NoModelError extends Error {}

export const isLocal = (model) => model?.provider === LOCAL_PROVIDER || /^(ollama|lmstudio|llama\.cpp|local)/i.test(model?.provider ?? "");

/** Select the best available default without requiring a provider login. */
export function chooseDefaultModel(available, { preferred = PREFERRED, fallback = FALLBACK } = {}) {
	const models = (Array.isArray(available) ? available : []).filter((m) => !isLocal(m));
	const sees = (model) => model?.input?.includes("image");
	return (
		models.find((m) => (m.provider === "openai" || m.provider === "openai-codex") && m.id === preferred) ??
		models.find((m) => m.provider === "openai-codex" && m.id === fallback) ??
		models.find((m) => sees(m) && m.reasoning) ??
		models.find(sees) ??
		models[0]
	);
}

/** Register (or replace) the user's local OpenAI-compatible endpoint, e.g. Ollama at http://localhost:11434/v1. */
export function registerLocalEndpoint(modelRuntime, local) {
	if (modelRuntime.getRegisteredProviderIds?.().includes(LOCAL_PROVIDER)) {
		try {
			modelRuntime.unregisterProvider(LOCAL_PROVIDER);
		} catch {}
	}
	if (!local?.enabled || !local.baseUrl || !local.model) return false;
	const url = new URL(local.baseUrl);
	if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) && !local.allowRemoteHost) {
		throw new Error("A local model endpoint must be on this computer (localhost); a remote host would send your data off the machine.");
	}
	modelRuntime.registerProvider(LOCAL_PROVIDER, {
		name: "Local model",
		baseUrl: local.baseUrl,
		api: "openai-completions",
		apiKey: "local",
		models: [{ id: local.model, name: `${local.model} (local)`, input: local.vision ? ["text", "image"] : ["text"], contextWindow: local.contextWindow ?? 32768, maxTokens: 4096 }],
	});
	return true;
}

/**
 * Pick the model for one mission run.
 * @param {{ provider?: string, model?: string, taskModel?: string, local?: object }} settings
 * @param {"cloud"|"local"|"offline"} privacy
 * @param {"task"|"quick"} kind  quick answers ("?") use the chosen model; everything else may use the task model
 */
export async function routeModel(modelRuntime, settings, privacy = "cloud", kind = "task") {
	if (privacy === "local" || privacy === "offline") {
		const m = settings.local?.enabled && settings.local.model ? modelRuntime.getModel(LOCAL_PROVIDER, settings.local.model) : undefined;
		if (!m) throw new NoLocalModelError("This mission is set to use only a local model, and none is set up. Add one in Settings → Models, or run the mission with a cloud model.");
		return { model: m, route: { provider: m.provider, model: m.id, privacy, reason: "privacy requires a local model" } };
	}
	// getAvailable() checks credentials now; hasConfiguredAuth() is a snapshot refreshed in the background.
	const avail = await modelRuntime.getAvailable();
	const usable = async (m) => !!m && (isLocal(m) || avail.some((x) => x.provider === m.provider && x.id === m.id) || !!(await modelRuntime.checkAuth?.(m.provider).catch(() => undefined)));
	const want = settings.provider && settings.model ? modelRuntime.getModel(settings.provider, settings.model) : undefined;
	if (kind === "task") {
		const [tp, ...tid] = (settings.taskModel ?? "").split("|");
		const task = tp && tid.length ? modelRuntime.getModel(tp, tid.join("|")) : undefined;
		if (await usable(task)) return { model: task, route: { provider: task.provider, model: task.id, privacy, reason: "your task model" } };
		// automatic: only upgrade from the fast default, never override a different model the user picked on purpose
		if (!settings.taskModel && (!want || want.id === PREFERRED)) {
			const strong = avail.find((m) => isOpenAI(m) && m.id === STRONG && (!want || m.provider === want.provider)) ?? avail.find((m) => isOpenAI(m) && m.id === STRONG);
			if (strong) return { model: strong, route: { provider: strong.provider, model: strong.id, privacy, reason: "stronger model for tasks" } };
		}
	}
	if (await usable(want)) return { model: want, route: { provider: want.provider, model: want.id, privacy, reason: "your choice" } };
	const m = chooseDefaultModel(avail.length ? avail : await modelRuntime.getAvailable());
	if (!m) throw new NoModelError("No model available. Open Settings and sign in to a provider, or set up a local model.");
	return { model: m, route: { provider: m.provider, model: m.id, privacy, reason: "best available" } };
}

/** What a model can be trusted with, from its catalog entry plus what we measured (opt-in benchmark). */
export function capabilities(model, measured = {}) {
	return {
		id: `${model.provider}/${model.id}`,
		local: isLocal(model),
		tools: model.provider !== LOCAL_PROVIDER || !!measured.toolCalls,
		vision: !!model.input?.includes("image"),
		reasoning: !!model.reasoning,
		contextWindow: model.contextWindow,
		measured,
	};
}

/**
 * Ask an Ollama-style endpoint to release a model from memory now (keep_alive 0). Quiet mode calls this so a
 * local model does not stay resident; the user's own server settings are otherwise left alone.
 */
export async function unloadLocalModel(local, fetchImpl = fetch) {
	if (!local?.enabled || !local.baseUrl || !local.model) return false;
	const base = local.baseUrl.replace(/\/v1\/?$/, "");
	try {
		const r = await fetchImpl(`${base}/api/generate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: local.model, keep_alive: 0 }), signal: AbortSignal.timeout(4000) });
		return r.ok;
	} catch {
		return false;
	}
}

/** Opt-in micro benchmark: tokens per second and whether the endpoint returns a well-formed tool call. */
export async function benchmarkLocal(local, fetchImpl = fetch) {
	const t0 = Date.now();
	const body = {
		model: local.model,
		messages: [{ role: "user", content: "Call the add tool with a=2 and b=3." }],
		tools: [{ type: "function", function: { name: "add", parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } } }],
		stream: false,
	};
	const r = await fetchImpl(`${local.baseUrl.replace(/\/$/, "")}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
	const j = await r.json();
	const ms = Date.now() - t0;
	const call = j?.choices?.[0]?.message?.tool_calls?.[0];
	let args = {};
	try {
		args = JSON.parse(call?.function?.arguments ?? "{}");
	} catch {}
	const tokens = j?.usage?.completion_tokens ?? 0;
	return { ms, tokensPerSecond: tokens && ms ? Math.round((tokens / ms) * 1000 * 10) / 10 : undefined, toolCalls: call?.function?.name === "add" && args.a === 2 && args.b === 3, at: new Date().toISOString() };
}
