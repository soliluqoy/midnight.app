import {
	createAgentSession,
	createExtensionRuntime,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { Type } from "typebox";
import { browserTool } from "./tools/browser.mjs";
import { computerTool } from "./tools/computer.mjs";
import { userBrowserTool, userContext } from "./tools/userbrowser.mjs";

const DEFAULT_MODEL = "gpt-5.5";

const SYSTEM_PROMPT = `You are midnight.server, a small desktop companion that lives in a capsule above the user's taskbar.
You work in plain view: the user watches a log of everything you read and do, and can press Esc to take over.

How you work:
- Questions and research (look something up, compare, summarize a page or a search): do NOT call \`plan\`. Go straight to work.
- Tasks that act (fill forms, click through sites, use the desktop, send anything): first call \`plan\` with 2-6 short steps.
  Mark a step "approval" if it sends, posts, buys, deletes, uploads or otherwise leaves the computer. Set usesComputer true
  only if you need the desktop (mouse/keyboard). \`plan\` blocks until the user approves; if declined, stop and say so.
  Then do the steps. The app tracks progress itself (first step starts on approval, everything is ticked when you finish),
  so do NOT call \`progress\` for plans of 4 steps or fewer. On longer plans call it only when a new step starts, in the same
  turn as that step's first action. Never spend a turn on progress alone.
- Before ANY action that leaves the computer or cannot be undone, call \`ask\` and wait. If declined, do not do it;
  offer the safe alternative (for example keep a draft).
Choosing where to browse (decide from the request and the [Context] line; don't ask the user which to use):
1. Public information → \`search\`, then \`read_pages\` with the 2-5 best URLs in ONE call and the question as \`query\`.
   Invisible and fastest. If snippets or the direct answer settle a simple fact, answer without reading pages.
2. "this page / this tab / this article / what I'm looking at / summarize this" → the page the user was on. If the [Context]
   line shows its URL, call \`read_pages\` with it directly; otherwise \`user_browser\` current_page. If that hits a login
   wall, the content is behind their session: read it from their browser with \`computer\` read_text (plan with usesComputer).
3. Doing something on a website:
   - Public site or no account needed → midnight's \`browser\` (background; never disturbs the user's screen).
   - Needs an account → \`browser\` session for that site first. Signed in there → use \`browser\`.
   - Not signed in there → use the user's own browser with \`computer\`, where they are already signed in (plan with
     usesComputer; say "in your Chrome" etc. in the plan). For recurring sites, suggest signing in once in midnight's browser (◫).
4. The user wants to see, keep or use a page themselves (a map, a video, a checkout, "open …") → \`user_browser\` open.
5. Never take over the user's browser for research or anything the background tools can do.

Computer use (only after a plan with usesComputer was approved; ignore the small purple capsule on screen):
- Start with \`elements\` on the target window (fast and exact) and act by id with \`click_element\` / \`set_value\`. Fall back to
  screenshot coordinates only for things that have no element (canvas, images, custom controls).
- \`windows\` + \`focus_window\` to switch apps (not alt+tab); \`launch\` to open an app, file or URL.
- Chain predictable steps with screenshot:false (e.g. set_value then key Enter), then take one screenshot to verify.
- To read what's in an app or in the user's browser tab (even signed-in pages), prefer \`read_text\` (exact, fast) over screenshots.
- \`zoom\` to read small text instead of guessing. Keyboard shortcuts beat menus (ctrl+l address bar, ctrl+t new tab, ctrl+f find).
- In the user's browser: ctrl+t for a new tab so you don't navigate away from what they had open.
- Look, act, verify. If something didn't change as expected, re-list elements rather than clicking again blindly.
- Never type passwords you were not given.

How you answer (the user reads it in a small panel, so make it scannable):
- Markdown. Lead with the direct answer in one or two sentences, in bold if it is a single fact.
- Then short bullet points or a small table. Headings (###) only for long answers.
- Cite web facts inline with [1], [2] matching a final list:
  **Sources**
  1. [Page title](https://url)
- Say so when sources disagree or are old. Never invent a source.
- For "latest / current / most recent / who is / how much now" questions, compare the newest date you can see against today's
  date. If nothing is recent enough, or a newer event may exist (a yearly event, a new release), search once more for it
  (add the current year) before answering.
- For tasks, the last message is the result: what you did, what you found, what needs the user.`;

const LENGTH = {
	brief: "Answer length: brief. At most about 5 lines plus sources.",
	normal: "Answer length: normal. Usually under 200 words plus sources.",
	detailed: "Answer length: detailed. Cover the topic thoroughly with sections, still scannable.",
};

// Screenshots dominate the token count of a desktop or browser run, and only the latest ones matter: the model acts on
// what it sees now. Older images become a one-line note, so long missions stay fast and cheap.
const KEEP_IMAGES = 3;
export function pruneImages(messages) {
	let seen = 0;
	const out = messages.slice();
	for (let i = out.length - 1; i >= 0; i--) {
		const m = out[i];
		if (m.role !== "toolResult" || !Array.isArray(m.content) || !m.content.some((c) => c.type === "image")) continue;
		if (++seen <= KEEP_IMAGES) continue;
		out[i] = { ...m, content: m.content.map((c) => (c.type === "image" ? { type: "text", text: "[older screenshot removed]" } : c)) };
	}
	return out;
}

// Prompt prefixes the user can type: "?" quick answer, "??" deep research.
export function expandPrompt(t) {
	if (t.startsWith("??")) {
		return `${t.slice(2).trim()}\n\n(Deep research: use 2-4 searches from different angles, read 6-10 good pages, compare them, note disagreements.)`;
	}
	if (t.startsWith("?")) {
		return `${t.slice(1).trim()}\n\n(Quick answer: one search; answer from the snippets if they are enough, read at most 2 pages; keep it short.)`;
	}
	return t;
}

export async function createHarness({ getBrowserContents, web, emit, hooks = {}, settings }) {
	const modelRuntime = await ModelRuntime.create();
	const state = { enabled: false, lastScale: 1, onAct: hooks.onAct };
	const pending = new Map();
	let session;
	let loginAbort;
	let current = { provider: "", model: "" };

	const waitDecision = (payload, signal) =>
		new Promise((resolve, reject) => {
			const id = randomUUID();
			pending.set(id, resolve);
			signal?.addEventListener("abort", () => {
				pending.delete(id);
				reject(new Error("aborted"));
			});
			emit({ ...payload, id });
		});

	const text = (t) => ({ content: [{ type: "text", text: t }], details: {} });

	const planTool = {
		name: "plan",
		label: "Plan",
		description: "Show the user your plan and wait for approval. Call first for any multi-step request.",
		promptSnippet: "plan: show the steps and get the user's approval before working",
		parameters: Type.Object({
			summary: Type.Optional(Type.String({ description: "One line: what will be done" })),
			steps: Type.Array(
				Type.Object({
					title: Type.String(),
					detail: Type.Optional(Type.String()),
					tag: Type.Optional(Type.Union([Type.Literal("browser"), Type.Literal("computer"), Type.Literal("approval")])),
				}),
			),
			usesComputer: Type.Optional(Type.Boolean({ description: "true if you need mouse/keyboard on the desktop" })),
		}),
		executionMode: "sequential",
		async execute(_id, p, signal) {
			const readOnly = !p.usesComputer && !p.steps.some((s) => s.tag === "approval");
			if (readOnly && settings.get().autoApproveReadOnly) {
				state.enabled = false;
				emit({ type: "plan", summary: p.summary, steps: p.steps, usesComputer: false, auto: true });
				emit({ type: "progress", step: 0, status: "active" });
				return text("Plan auto-approved (it only reads). Proceed.");
			}
			const ok = await waitDecision({ type: "plan", summary: p.summary, steps: p.steps, usesComputer: !!p.usesComputer }, signal);
			const allowed = settings.get().computerUse !== "never" && process.platform === "win32";
			state.enabled = ok === true && !!p.usesComputer && allowed;
			if (ok === true) emit({ type: "progress", step: 0, status: "active" });
			if (ok === true && p.usesComputer && process.platform !== "win32") {
				return text("Plan approved, but computer use is only available on Windows for now. Do the parts you can with the browser tools and say what you could not do.");
			}
			if (ok === true && p.usesComputer && !allowed) {
				return text("Plan approved, but the user has turned computer use off in Settings. Do the parts you can with the browser and say what you could not do.");
			}
			return text(ok === true ? "Plan approved. Proceed." : "The user declined the plan. Stop and tell them.");
		},
	};

	const progressTool = {
		name: "progress",
		label: "Progress",
		description: "Update a plan step: 0-based index and status active, done or skipped, with an optional short note.",
		parameters: Type.Object({
			step: Type.Integer(),
			status: Type.Union([Type.Literal("active"), Type.Literal("done"), Type.Literal("skipped")]),
			note: Type.Optional(Type.String()),
		}),
		async execute(_id, p) {
			emit({ type: "progress", step: p.step, status: p.status, note: p.note });
			return text("ok");
		},
	};

	const askTool = {
		name: "ask",
		label: "Ask",
		description:
			"Ask the user to approve one specific action before you do it (send, post, buy, delete, upload...). Blocks for the answer.",
		parameters: Type.Object({
			title: Type.String({ description: "Short, e.g. Send email to Sam?" }),
			detail: Type.Optional(Type.String({ description: "Exactly what will happen, including recipients and content summary" })),
			approveLabel: Type.Optional(Type.String()),
			declineLabel: Type.Optional(Type.String({ description: "e.g. Keep as draft" })),
		}),
		executionMode: "sequential",
		async execute(_id, p, signal) {
			const ok = await waitDecision({ type: "ask", ...p }, signal);
			return text(ok === true ? "Approved. Go ahead." : "Declined by the user. Do not do it.");
		},
	};

	const resourceLoader = {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => {
			const st = settings.get();
			const base = `${SYSTEM_PROMPT}\n${LENGTH[st.answerLength] ?? LENGTH.normal}\nToday is ${new Date().toDateString()}.`;
			const extra = st.instructions.trim();
			return extra ? `${base}

The user's standing instructions (follow them unless unsafe):
${extra}` : base;
		},
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};

	async function pickModel() {
		const { provider, model } = settings.get();
		const want = provider && model ? modelRuntime.getModel(provider, model) : undefined;
		if (want && modelRuntime.hasConfiguredAuth(provider)) return want;
		const avail = await modelRuntime.getAvailable();
		const sees = (m) => m.input?.includes("image");
		return (
			avail.find((m) => m.provider === "openai-codex" && m.id === DEFAULT_MODEL) ??
			avail.find((m) => sees(m) && m.reasoning) ??
			avail.find(sees) ??
			avail[0]
		);
	}

	const interaction = (signal) => ({
		signal,
		notify: (ev) => emit({ type: "auth_event", event: ev }),
		prompt: async (p) => {
			const v = await waitDecision(
				{ type: "auth_prompt", prompt: { kind: p.type, message: p.message, placeholder: p.placeholder, options: p.options } },
				signal,
			);
			if (v === null || v === false || v === undefined) throw new Error("Cancelled");
			return v;
		},
	});

	async function open() {
		session?.dispose();
		for (const r of pending.values()) r(false);
		pending.clear();
		state.enabled = false;
		const model = await pickModel();
		if (!model) {
			session = undefined;
			current = { provider: "", model: "" };
			return;
		}
		current = { provider: model.provider, model: model.id };
		const cwd = homedir();
		({ session } = await createAgentSession({
			cwd,
			model,
			thinkingLevel: settings.get().thinking,
			modelRuntime,
			resourceLoader,
			tools: ["plan", "progress", "ask", ...web.tools.map((t) => t.name), "user_browser", "browser", "computer"],
			customTools: [planTool, progressTool, askTool, ...web.tools, userBrowserTool(web), browserTool(getBrowserContents), computerTool(state)],
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: true, maxRetries: 2 } }),
		}));
		const transform = session.agent.transformContext;
		session.agent.transformContext = async (messages, signal) => pruneImages(transform ? await transform(messages, signal) : messages);
		session.subscribe((e) => {
			if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta") {
				emit({ type: "text", delta: e.assistantMessageEvent.delta });
			} else if (e.type === "message_start" && e.message.role === "assistant") {
				emit({ type: "assistant_start" });
			} else if (e.type === "tool_execution_start") {
				emit({ type: "tool_start", id: e.toolCallId, name: e.toolName, args: e.args });
			} else if (e.type === "tool_execution_end") {
				emit({ type: "tool_end", id: e.toolCallId, name: e.toolName, isError: e.isError, urls: e.result?.details?.urls });
			} else if (e.type === "agent_start") {
				emit({ type: "start" });
			} else if (e.type === "agent_end") {
				state.enabled = false;
				emit({ type: "done" });
			}
		});
	}

	await open();

	return {
		state,
		current: () => current,
		hasSession: () => !!session,
		accounts() {
			return modelRuntime
				.getProviders()
				.map((p) => {
					const st = modelRuntime.getProviderAuthStatus(p.id);
					return {
						id: p.id,
						name: p.name,
						oauth: !!p.auth?.oauth,
						apiKey: !!p.auth?.apiKey?.login,
						configured: !!st.configured,
						source: st.source,
						label: st.label,
					};
				})
				.sort((a, b) => Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name));
		},
		async models() {
			const avail = await modelRuntime.getAvailable();
			return avail.map((m) => ({
				provider: m.provider,
				providerName: modelRuntime.getProvider(m.provider)?.name ?? m.provider,
				id: m.id,
				name: m.name,
				vision: !!m.input?.includes("image"),
				reasoning: !!m.reasoning,
			}));
		},
		decide(id, value) {
			pending.get(id)?.(value);
			pending.delete(id);
		},
		// `key` is an API key pasted in Settings: it answers the provider's first secret prompt.
		async login(providerId, type, key) {
			loginAbort = new AbortController();
			const ui = interaction(loginAbort.signal);
			if (key) {
				const ask = ui.prompt;
				let used = false;
				ui.prompt = async (p) => (p.type === "secret" && !used ? ((used = true), key) : ask(p));
			}
			try {
				await modelRuntime.login(providerId, type, ui);
			} finally {
				loginAbort = undefined;
			}
		},
		cancelLogin: () => loginAbort?.abort(),
		async logout(providerId) {
			await modelRuntime.logout(providerId);
		},
		reload: () => open(),
		async send(t) {
			if (!session) {
				emit({ type: "error", message: "No model available. Open Settings and sign in to a provider." });
				emit({ type: "done" });
				return;
			}
			try {
				let ctx = "";
				if (settings.get().shareContext) ctx = await Promise.race([userContext().catch(() => ""), new Promise((r) => setTimeout(() => r(""), 800))]);
				await session.prompt(ctx ? `${expandPrompt(t)}\n\n[Context: ${ctx}]` : expandPrompt(t));
			} catch (err) {
				emit({ type: "error", message: String(err?.message ?? err) });
				emit({ type: "done" });
			}
		},
		abort: () => session?.abort(),
		reset: () => open(),
	};
}
