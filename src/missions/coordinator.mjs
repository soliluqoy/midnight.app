// The mission coordinator (plan ch. 05, 08, 18). user or trusted trigger -> mission -> current plan -> brokered
// actions -> verification -> receipt -> projection. It decides mission state; the runtime only reports that a run
// settled. Success requires every declared check to pass.
import { TERMINAL_STATES } from "../contracts/domain.mjs";
import { newId } from "../contracts/events.mjs";
import { labelFor, systemPrompt, titleFor, expandPrompt } from "../runtime/prompts.mjs";
import { routeModel } from "../runtime/models.mjs";
import { citedUrls, evaluateChecks, implicitPlan, normalizePlan, outcomeOf } from "./plan.mjs";
import { PRIORITY } from "../scheduler/queue.mjs";

const text = (t, details = {}) => ({ content: [{ type: "text", text: t }], details });
const STALE_UI_EFFECTS = new Set(["desktop.input", "desktop.observe", "browser.commit"]);
const SAFE_TO_RETRY = new Set(["read.local", "read.web", "read.connector", "compute", "artifact.stage", "browser.navigate", "desktop.observe", "open.user"]);

export function createCoordinator(d) {
	const { commit, emit, journal, repo, ledger, approvals, grants, budgets, evidence, runtime, queue, stop, roots, live, toolset, toPiTool, broker, memory, skills, platform, log = () => {} } = d;
	const settings = () => d.settings();
	const runs = new Map(); // missionId -> { runId, ac }
	const questionWaiters = new Map(); // questionId -> resolve(answer)
	const planWaiters = new Map(); // approvalId -> resolve

	// ---------- helpers ----------
	function setStatus(missionId, to, reason) {
		const m = repo.get(missionId);
		if (!m || m.status === to) return m;
		return repo.setStatus(missionId, to, reason);
	}
	function enqueue(missionId, pending, { priority } = {}) {
		const m = repo.get(missionId);
		commit(() => {
			store_pending(missionId, pending);
			if (m.status !== "queued") setStatus(missionId, "queued", pending.followUp ? "follow-up" : pending.resume ? "resume" : "");
		});
		queue.enqueue({ missionId, priority: priority ?? m.priority ?? PRIORITY.user, slot: m.privacy === "cloud" ? "network" : "inference", speculative: m.trigger?.kind === "suggestion" });
	}
	function store_pending(missionId, pending) {
		const m = repo.get(missionId);
		d.store.run("UPDATE missions SET scope = ? WHERE id = ?", JSON.stringify({ ...m.scope, pending }), missionId);
	}
	function clearPending(missionId) {
		const m = repo.get(missionId);
		const { pending, ...rest } = m.scope;
		d.store.run("UPDATE missions SET scope = ? WHERE id = ?", JSON.stringify(rest), missionId);
	}

	// ---------- creating and running ----------
	function createMission({ text: input, requestId, mode, skill, privacy, trigger = { kind: "user" }, watchId, priority = PRIORITY.user, context, dryRun = false, title }) {
		const dup = repo.runByRequest(requestId) ?? d.store.get("SELECT id FROM missions WHERE json_extract(scope, '$.pending.requestId') = ?", requestId);
		if (dup) return { missionId: dup.mission_id ?? dup.id, duplicate: true };
		const st = settings();
		const m = commit(() => {
			const created = repo.create({ title: title ?? titleFor(input), goal: input, mode: mode ?? st.mode ?? "ask", privacy: privacy ?? st.privacy ?? "cloud", trigger, skill, watchId, priority, label: labelFor(input), dryRun });
			const b = budgets.create(created.id, st.budget ?? {});
			repo.setBudget(created.id, b.id);
			return created;
		});
		enqueue(m.id, { input, requestId, context, followUp: false }, { priority });
		return { missionId: m.id, duplicate: false };
	}

	/** Called by the queue when a slot is free. */
	async function start(item) {
		const { missionId } = item;
		try {
			await runMission(missionId);
		} catch (err) {
			log("run failed", missionId, err);
			try {
				commit(() => {
					const m = repo.get(missionId);
					if (m && !TERMINAL_STATES.has(m.status) && m.status !== "paused") {
						if (m.status === "queued") setStatus(missionId, "running");
						setStatus(missionId, "failed", String(err?.message ?? err));
						emit("mission.completed", { missionId, payload: { status: "failed", summary: String(err?.message ?? err).slice(0, 300), passed: [], missing: ["the run could not finish"] } });
					}
				});
			} catch {}
		} finally {
			runs.delete(missionId);
			queue.done(missionId);
		}
	}

	async function runMission(missionId) {
		const m = repo.get(missionId);
		const pend = m?.scope?.pending;
		if (!m || !pend || ["paused", "cancelled"].includes(m.status)) return;
		const st = settings();
		let route;
		try {
			route = await routeModel(runtime.modelRuntime, st, m.privacy, labelFor(m.goal) === "QUICK ANSWER" ? "quick" : "task");
		} catch (err) {
			commit(() => {
				clearPending(missionId);
				setStatus(missionId, "running");
				setStatus(missionId, "failed", err.message);
				emit("mission.completed", { missionId, payload: { status: "failed", summary: err.message, passed: [], missing: ["no model could run this mission"] } });
			});
			return;
		}
		const run = commit(() => {
			const r = repo.startRun({ missionId, requestId: pend.requestId, input: pend.input, runtimeVersion: runtime.version, modelRoute: route.route, followUp: !!pend.followUp });
			clearPending(missionId);
			if (!r.duplicate) setStatus(missionId, "running");
			return r;
		});
		if (run.duplicate) return;
		const ac = new AbortController();
		runs.set(missionId, { runId: run.id, ac });
		stop.clearMission(missionId);
		const fresh = repo.get(missionId);
		const skill = fresh.skill ? skills?.get(fresh.skill) : undefined;
		const memories = memory ? memory.relevant(pend.input, { limit: 6 }).map((x) => x.text) : [];
		const tools = toolset(fresh).map((spec) => toPiTool(spec, missionId, run.id));
		const input = buildInput(pend);
		const res = await runtime.run(missionId, {
			runId: run.id,
			input,
			model: route.model,
			thinking: st.thinking ?? "low",
			systemPrompt: systemPrompt({ answerLength: st.answerLength, instructions: st.instructions, memories, skill, roots: roots.list(), mode: fresh.mode, privacy: fresh.privacy }),
			tools,
			sessionFile: fresh.conversation,
			onSession: (file) => file && file !== fresh.conversation && commit(() => repo.setConversation(missionId, file)),
			gate: {
				gate: (e) => broker.gate({ missionId, runId: run.id, toolCallId: e.toolCallId, toolName: e.toolName, input: e.input, signal: mergeSignals(e.signal, ac.signal) }),
				result: (e) => broker.foreignResult(e),
			},
		});
		await settle(missionId, run.id, res);
	}

	function buildInput(p) {
		let t = p.resume ? p.input : expandPrompt(p.input);
		if (p.context) t += `\n\n[Context: ${p.context}]`;
		if (p.unfinished) t += `\n\n[Midnight: this mission is not finished. Missing: ${p.unfinished}. If the message is about that, do the missing part now.]`;
		return t;
	}

	async function settle(missionId, runId, res) {
		commit(() => {
			if (res.sessionFile) repo.setConversation(missionId, res.sessionFile);
			const b = budgets.record(missionId, { tokens: res.usage.tokens, modelCalls: res.usage.modelCalls, costUsd: res.usage.unknownCost && !res.usage.costUsd ? undefined : res.usage.costUsd });
			if (b) emit("budget.updated", { missionId, payload: { text: budgets.describe(b), spent: b.spent, limits: b.limits } });
			if (res.answer?.trim()) {
				const ref = journal.putPayload(missionId, "answer", res.answer);
				emit("answer.recorded", { missionId, runId, payload: { ref, chars: res.answer.length } });
			}
			repo.endRun(runId, { outcome: res.error ? "error" : res.aborted ? "aborted" : "settled" });
			emit("run.settled", { missionId, runId, payload: { reason: res.error ? "error" : res.aborted ? "aborted" : "settled", error: res.error?.slice(0, 300) } });
		});
		const m = repo.get(missionId);
		if (["paused", "cancelled", "waiting-resource", "needs-reconciliation"].includes(m.status) || m.status.startsWith("waiting")) {
			if (m.status === "waiting-resource" || m.status === "needs-reconciliation") emitRecovery(missionId);
			return;
		}
		await verify(missionId, runId, res);
	}

	function factsFor(missionId, answer) {
		const intents = ledger.forMission(missionId);
		const counts = evidence.counts(missionId);
		const m = repo.get(missionId);
		return {
			answer,
			retrievedUrls: evidence.retrievedUrls(missionId),
			artifacts: evidence.artifacts(missionId),
			receipts: intents.map((i) => ({ effect: i.effect, state: ledger.latestReceipt(i.id)?.state === "rehearsed" ? "rehearsed" : i.state })),
			evidence: counts.evidence,
			calculations: counts.calculations,
			confirmations: new Map(Object.entries(m.outcome?.confirmations ?? {})),
		};
	}

	async function verify(missionId, runId, res = {}) {
		const answer = res.answer ?? latestAnswer(missionId);
		commit(() => setStatus(missionId, "verifying"));
		const plan = repo.plan(missionId) ?? implicitPlan();
		const checks = [...plan.checks];
		if (!checks.some((c) => c.kind === "citations") && citedUrls(answer).length) checks.push({ id: `c${checks.length + 1}`, kind: "citations", label: "Every cited web source was actually read during this mission", params: {}, required: true });
		const results = evaluateChecks(checks, factsFor(missionId, answer));
		// Without a declared plan, an answer alone would look like success even if the mission tried to change something
		// and was blocked (for example by planted instructions). Surface those attempts instead of hiding them.
		if (!repo.plan(missionId)) {
			const attempted = ledger.forMission(missionId).filter((i) => (!runId || i.runId === runId) && !SAFE_TO_RETRY.has(i.effect) && ["denied", "failed", "cancelled"].includes(i.state));
			if (attempted.length) results.push({ id: "implicit-actions", kind: "actions", label: "Actions the mission attempted", required: true, state: "failed", detail: `${attempted.length} attempted action${attempted.length > 1 ? "s were" : " was"} blocked or failed: ${attempted.slice(0, 3).map((i) => i.display.title ?? i.tool).join("; ")}` });
		}
		let status = outcomeOf(results);
		if (res.error && status === "succeeded") status = "partially-succeeded";
		const passed = results.filter((r) => r.state === "passed").map((r) => r.label);
		const missing = results.filter((r) => r.state !== "passed").map((r) => `${r.label}: ${r.detail}`);
		const summary = res.error ? `The model stopped with an error: ${res.error}` : status === "succeeded" ? `${passed.length}/${results.length} checks passed` : missing[0] ?? "";
		commit(() => {
			emit(status === "succeeded" ? "verification.passed" : "verification.failed", { missionId, runId, payload: { results } });
			setStatus(missionId, status === "waiting-input" ? "waiting-input" : status);
			if (status === "waiting-input") repo.setWaiting(missionId, { kind: "confirm", reason: "Confirm the result to finish" });
			if (TERMINAL_STATES.has(status)) {
				repo.setOutcome(missionId, { ...repo.get(missionId).outcome, status, summary });
				emit("mission.completed", { missionId, runId, payload: { status, summary, passed, missing } });
			}
		});
		if (status === "needs-reconciliation") emitRecovery(missionId);
		const m = repo.get(missionId);
		if (TERMINAL_STATES.has(status) && m.trigger?.kind !== "user") d.attention?.missionFinished(m, status, summary);
		return status;
	}

	const latestAnswer = (missionId) => {
		const e = d.store.get("SELECT payload FROM events WHERE mission_id = ? AND type = 'answer.recorded' ORDER BY seq DESC LIMIT 1", missionId);
		return e ? journal.getPayload(JSON.parse(e.payload).ref) ?? "" : "";
	};

	// ---------- tools the model calls ----------
	async function proposePlan(missionId, input, signal) {
		const plan = normalizePlan(input);
		const prior = repo.plan(missionId);
		commit(() => repo.addPlan(missionId, plan, prior ? input.reason || "revised" : "initial"));
		const st = settings();
		if (!plan.usesComputer) return text(`Plan recorded (revision ${repo.get(missionId).planRevision}) with ${plan.checks.length} outcome check${plan.checks.length === 1 ? "" : "s"}. Proceed.`);
		if (st.computerUse === "never") return text("Plan recorded, but the user has turned off desktop control in Settings. Do the parts you can without the desktop and say what you could not do.");
		if (process.platform !== "win32" && !d.allowNonWindowsDesktop) return text("Plan recorded, but desktop control is only available on Windows. Do what you can with the browser tools.");
		// Desktop control is authority: only the user's approval of this plan can grant it, for this mission only.
		const display = {
			title: "Let midnight use your screen for this plan",
			verb: "Approve plan",
			decline: "Not now",
			effect: "desktop.input",
			effectLabel: "use your mouse and keyboard",
			consequence: "Midnight takes the screen only while an action runs. Press Esc anytime to take over.",
			preview: plan.nodes.map((n, i) => `${i + 1}. ${n.title}${n.tag === "approval" ? " (asks first)" : ""}`).join("\n"),
			plan: true,
		};
		const { approval } = commit(() => {
			const intent = ledger.prepare({ missionId, runId: runs.get(missionId)?.runId, tool: "plan", effect: "desktop.input", target: "desktop", argsHash: `plan:${missionId}:${repo.get(missionId).planRevision}`, display });
			ledger.transition(intent.id, "waiting-approval");
			const a = approvals.request({ intentId: intent.id, missionId, intentHash: intent.argsHash, display });
			emit("approval.requested", { missionId, correlationId: intent.id, payload: { approvalId: a.id, intentId: intent.id, nonce: a.nonce, intentHash: a.intentHash, display, expiresAt: a.expiresAt } });
			setStatus(missionId, "waiting-approval", "plan approval");
			return { approval: a, intent };
		});
		const decided = await approvals.wait(approval.id, signal);
		commit(() => {
			const intent = ledger.get(approval.intentId);
			ledger.transition(intent.id, decided.status === "approved" ? "authorized" : decided.status === "cancelled" ? "cancelled" : "denied");
			emit("approval.recorded", { missionId, correlationId: intent.id, payload: { approvalId: approval.id, intentId: intent.id, status: decided.status, decision: decided.decision } });
			if (repo.get(missionId).status === "waiting-approval") setStatus(missionId, "running", "plan decided");
		});
		if (decided.status !== "approved") return text("The user did not approve desktop control. Stop and tell them; offer to do the parts that don't need the screen.");
		const g = grants.create({ label: `Use the screen for “${repo.get(missionId).title}”`, actionClasses: ["desktop.input", "desktop.observe"], missionId, expiresInDays: 1 }, "user:plan-approval");
		commit(() => emit("grant.created", { missionId, payload: { grantId: g.id, label: g.label } }));
		return text("Plan approved, including desktop control for this mission. Proceed.");
	}

	function markStep(missionId, { step, status, note }) {
		const plan = repo.plan(missionId);
		const node = plan?.nodes[step];
		if (!node) return text(`There is no step ${step}; the plan has ${plan?.nodes.length ?? 0}.`);
		commit(() => {
			if (status === "active") for (const n of plan.nodes.slice(0, step)) if (repo.steps(missionId).find((s) => s.node_id === n.id)?.state === "active") repo.setStep(missionId, n.id, "done");
			repo.setStep(missionId, node.id, status, note ?? "");
		});
		return text("ok");
	}

	async function askUser(missionId, question, options, signal) {
		const qid = commit(() => {
			const id = repo.ask(missionId, question, options);
			setStatus(missionId, "waiting-input", "question");
			repo.setWaiting(missionId, { kind: "input", reason: question.slice(0, 200), question: { id, prompt: question, options } });
			return id;
		});
		const answer = await new Promise((resolve) => {
			questionWaiters.set(qid, resolve);
			signal?.addEventListener("abort", () => resolve(undefined), { once: true });
		});
		questionWaiters.delete(qid);
		if (answer === undefined) return text("The question was withdrawn (the mission was paused or cancelled).");
		commit(() => {
			if (repo.get(missionId).status === "waiting-input") setStatus(missionId, "running", "answered");
		});
		return text(`The user answered: ${answer}`);
	}

	function suggestMemory(missionId, t, kind) {
		if (!memory) return text("Memory is not available.");
		const r = memory.suggest(t, { kind, missionId });
		return text(r.duplicate ? "Already remembered." : "Saved as a suggestion; the user can confirm it in Settings → Memory. It does not grant any permission.");
	}

	// ---------- user controls ----------
	function followUp(missionId, input, requestId, context) {
		const m = repo.get(missionId);
		if (!m) throw new Error("no such mission");
		if (runtime.isRunning(missionId)) return steer(missionId, input);
		if (m.status === "waiting-input" && m.waiting?.question) return answer(missionId, m.waiting.question.id, input);
		// The model does not see Midnight's checks; tell it what is still missing so a nudge leads to work, not an apology.
		const unfinished = ["partially-succeeded", "failed"].includes(m.status) && m.outcome?.summary ? m.outcome.summary : undefined;
		enqueue(missionId, { input, requestId, context, followUp: true, unfinished });
		return { queued: true };
	}
	async function steer(missionId, input) {
		const ok = await runtime.steer(missionId, input);
		if (ok) commit(() => emit("run.started", { missionId, runId: runs.get(missionId)?.runId, payload: { input: input.slice(0, 300), followUp: true, steer: true } }));
		return { steered: ok };
	}
	function answer(missionId, questionId, value) {
		const ok = commit(() => repo.answer(questionId, value));
		if (!ok) return { ok: false, error: "that question was already answered" };
		const w = questionWaiters.get(questionId);
		if (w) w(value);
		else {
			// The run that asked is gone (restart): continue the conversation with the answer.
			const q = repo.question(questionId);
			enqueue(missionId, { input: `[Midnight] Earlier you asked the user: "${q.prompt}". They answered: ${value}. Continue the mission.`, requestId: newId("req"), resume: true });
		}
		return { ok: true };
	}
	async function pause(missionId) {
		stop.stopMission(missionId, "paused");
		queue.remove(missionId);
		await runtime.abort(missionId);
		await platform?.lease?.release?.(missionId);
		commit(() => {
			const m = repo.get(missionId);
			if (!TERMINAL_STATES.has(m.status) && m.status !== "paused") setStatus(missionId, "paused", "you paused it");
		});
		return { ok: true };
	}
	function resume(missionId) {
		const m = repo.get(missionId);
		if (m.status !== "paused") return { ok: false, error: `mission is ${m.status}` };
		stop.clearMission(missionId);
		const summary = progressNote(missionId);
		enqueue(missionId, { input: `[Midnight] The user resumed this paused mission. ${summary} Continue from where you stopped; do not repeat completed actions.`, requestId: newId("req"), resume: true });
		return { ok: true };
	}
	async function cancel(missionId) {
		stop.stopMission(missionId, "cancelled");
		queue.remove(missionId);
		for (const a of approvals.pending(missionId)) approvals.close(a.id, "cancelled");
		await runtime.abort(missionId);
		await platform?.lease?.release?.(missionId);
		commit(() => {
			for (const i of ledger.forMission(missionId)) if (["prepared", "authorized", "waiting-approval"].includes(i.state)) ledger.transition(i.id, "cancelled");
			const m = repo.get(missionId);
			if (TERMINAL_STATES.has(m.status)) return;
			setStatus(missionId, "cancelled", "you cancelled it");
			const kept = evidence.artifacts(missionId).length;
			emit("mission.completed", { missionId, payload: { status: "cancelled", summary: kept ? `Cancelled. ${kept} draft${kept > 1 ? "s" : ""} kept.` : "Cancelled.", passed: [], missing: [] } });
		});
		return { ok: true };
	}
	async function emergencyStop() {
		const t0 = Date.now();
		stop.emergencyStop();
		await platform?.lease?.revokeAll?.();
		const ackMs = Date.now() - t0;
		const active = runtime.running();
		await Promise.all(active.map((id) => runtime.abort(id).catch(() => {})));
		commit(() => {
			for (const id of active) {
				const m = repo.get(id);
				if (m && !TERMINAL_STATES.has(m.status)) setStatus(id, "paused", "emergency stop");
			}
			emit("system.stopped", { payload: { ackMs, missions: active.length } });
		});
		return { ackMs, paused: active.length };
	}
	function clearEmergency() {
		stop.clearEmergency();
		stop.setProactivePaused(false);
	}
	function confirm(missionId, checkId, ok) {
		const m = repo.get(missionId);
		commit(() => repo.setOutcome(missionId, { ...m.outcome, confirmations: { ...(m.outcome?.confirmations ?? {}), [checkId]: ok } }));
		if (m.status === "waiting-input") {
			commit(() => setStatus(missionId, "running", "confirmed"));
			return verify(missionId, undefined, {});
		}
		return m.status;
	}
	function archive(missionId) {
		commit(() => repo.setArchived(missionId, true));
		return { ok: true };
	}

	/** A trusted approval decision from the capsule. */
	async function decideApproval({ approvalId, nonce, intentHash, decision }) {
		const a = approvals.get(approvalId);
		if (!a) return { ok: false, error: "no such approval" };
		const intent = ledger.get(a.intentId);
		const r = approvals.decide(approvalId, { nonce, intentHash, decision, currentHash: intent?.argsHash });
		if (!r.ok) return r;
		if (approvals.hasWaiter?.(approvalId) || runtime.isRunning(a.missionId)) return r; // the live run continues
		// No run is waiting (Midnight restarted while this was pending): dispatch the stored intent, then continue.
		if (r.approval.status === "approved" && intent.tool !== "plan") {
			let outcome;
			try {
				commit(() => {
					ledger.transition(intent.id, "authorized", { authority: { kind: "approval", approvalId } });
					emit("approval.recorded", { missionId: a.missionId, correlationId: intent.id, payload: { approvalId, intentId: intent.id, status: "approved", decision } });
				});
				const out = await broker.dispatchStored(intent.id);
				outcome = `it was done: ${(out.content ?? []).map((c) => c.text ?? "").join(" ").slice(0, 400)}`;
			} catch (err) {
				outcome = `it could not be done: ${String(err?.message ?? err).slice(0, 300)}`;
			}
			enqueue(a.missionId, { input: `[Midnight] After a restart the user approved "${intent.display.title}"; ${outcome}. Continue the mission without repeating it.`, requestId: newId("req"), resume: true });
		} else {
			commit(() => {
				if (!["denied", "cancelled"].includes(ledger.get(intent.id).state)) ledger.transition(intent.id, "denied");
				emit("approval.recorded", { missionId: a.missionId, correlationId: intent.id, payload: { approvalId, intentId: intent.id, status: r.approval.status, decision } });
			});
			enqueue(a.missionId, { input: `[Midnight] The user ${decision === "keep-draft" ? "chose to keep it as a draft" : "declined"}: "${intent.display.title}". Do not do it. Tell them what is ready.`, requestId: newId("req"), resume: true });
		}
		return r;
	}

	/** The user decides what happened to an uncertain action (after checking themselves). */
	async function resolveUnknown(missionId, intentId, outcome) {
		const i = broker.resolveUnknown(intentId, outcome);
		const left = ledger.forMission(missionId).filter((x) => x.state === "unknown");
		if (!left.length && repo.get(missionId).status === "needs-reconciliation") {
			enqueue(missionId, { input: `[Midnight] The user confirmed that "${i.display.title}" ${outcome === "happened" ? "did happen" : "did not happen"}. ${outcome === "happened" ? "Do not repeat it." : "You may try again if it is still needed."} Continue.`, requestId: newId("req"), resume: true });
		}
		return { ok: true, state: i.state };
	}

	// ---------- recovery (plan ch. 18) ----------
	function progressNote(missionId) {
		const intents = ledger.forMission(missionId);
		const done = intents.filter((i) => i.state === "verified" && !["read.web", "read.local", "compute", "browser.navigate", "desktop.observe"].includes(i.effect)).map((i) => i.display.title ?? i.tool);
		const unknown = intents.filter((i) => i.state === "unknown").map((i) => i.display.title ?? i.tool);
		const arts = evidence.artifacts(missionId).map((a) => `${a.name} r${a.revision}`);
		return [done.length ? `Verified so far: ${done.join("; ")}.` : "", arts.length ? `Drafts: ${arts.join(", ")}.` : "", unknown.length ? `Uncertain (do not retry): ${unknown.join("; ")}.` : ""].filter(Boolean).join(" ");
	}
	function emitRecovery(missionId) {
		const intents = ledger.forMission(missionId);
		const finished = [
			...intents.filter((i) => i.state === "verified" && !i.effect.startsWith("read") && i.effect !== "compute").map((i) => i.display.title ?? i.tool),
			...evidence.artifacts(missionId).map((a) => `${a.name} r${a.revision}${a.validation?.ok ? " (validated)" : ""}`),
		];
		const uncertain = intents.filter((i) => i.state === "unknown").map((i) => ({ intentId: i.id, title: i.display.title ?? i.tool, effect: i.effect }));
		const m = repo.get(missionId);
		const next =
			m.status === "needs-reconciliation"
				? "Check whether the uncertain action happened before anything is retried."
				: m.status === "waiting-approval"
					? "Review the pending approval; it was re-checked after the restart."
					: m.status === "waiting-input"
						? "Answer the open question to continue."
						: m.status === "waiting-resource"
							? "This mission reached its budget. Extend it to continue."
							: "Continuing where it stopped.";
		commit(() => emit("system.recovered", { missionId, payload: { finished, uncertain, next } }));
	}

	async function recover() {
		const t0 = Date.now();
		const touched = new Set();
		commit(() => {
			for (const r of repo.openRuns()) {
				repo.endRun(r.id, { outcome: "interrupted", recoveryReason: "Midnight stopped while this run was active" });
				touched.add(r.mission_id);
			}
			for (const i of ledger.inFlight()) {
				// Safe retry vs unsafe reconciliation: an interrupted read changed nothing and can simply run again;
				// anything that may have changed the world is "unknown" until checked.
				const safe = SAFE_TO_RETRY.has(i.effect);
				const state = safe ? "failed" : "unknown";
				ledger.transition(i.id, state);
				ledger.receipt(i.id, { state, observed: { reason: "Midnight stopped while this action was in progress", retryable: safe } });
				emit("action.reconciled", { missionId: i.missionId, correlationId: i.id, payload: { intentId: i.id, tool: i.tool, effect: i.effect, state } });
				touched.add(i.missionId);
			}
			for (const i of ledger.notDispatched()) {
				ledger.transition(i.id, "cancelled");
				touched.add(i.missionId);
			}
			// Approvals for screen or browser commits cannot survive: the UI they described is gone.
			for (const a of approvals.pending()) {
				const intent = ledger.get(a.intentId);
				if (STALE_UI_EFFECTS.has(intent?.effect) && intent.tool !== "plan") {
					approvals.close(a.id, "expired");
					ledger.transition(intent.id, "cancelled");
				} else if (intent?.tool === "plan") {
					approvals.close(a.id, "expired");
					ledger.transition(intent.id, "cancelled");
				}
				touched.add(a.missionId);
			}
			d.store.run("DELETE FROM leases");
		});
		// Ask each tool that can check whether an uncertain effect happened.
		for (const i of ledger.unresolved()) await broker.reconcile(i.id).catch(() => {});
		const active = repo.withStatus("queued", "planning", "ready", "running", "verifying", "recovering", "waiting-approval", "waiting-input", "needs-reconciliation");
		for (const m of active) touched.add(m.id);
		for (const id of touched) {
			const m = repo.get(id);
			if (!m || TERMINAL_STATES.has(m.status) || m.status === "paused" || m.archived) continue;
			const unknown = ledger.forMission(id).some((i) => i.state === "unknown");
			const pendingApproval = approvals.pending(id).length > 0;
			const openQ = repo.openQuestions(id);
			commit(() => {
				if (m.status !== "recovering" && m.status !== "queued") setStatus(id, "recovering", "restart");
				if (unknown) setStatus(id, "needs-reconciliation", "an action's outcome is unknown");
				else if (pendingApproval) setStatus(id, "waiting-approval", "approval survived restart");
				else if (openQ.length) {
					setStatus(id, "waiting-input", "question survived restart");
					repo.setWaiting(id, { kind: "input", reason: openQ[0].prompt.slice(0, 200), question: { id: openQ[0].id, prompt: openQ[0].prompt, options: openQ[0].options } });
				}
			});
			const now = repo.get(id);
			if (["recovering", "queued"].includes(now.status)) {
				const p = now.scope.pending;
				if (p) queue.enqueue({ missionId: id, priority: now.priority, slot: now.privacy === "cloud" ? "network" : "inference" });
				else enqueue(id, { input: `[Midnight] Midnight restarted while you were working on this mission. ${progressNote(id)} Continue from where you stopped. Do not repeat verified actions; uncertain ones are being checked.`, requestId: newId("req"), resume: true });
			}
			emitRecovery(id);
		}
		commit(() => emit("system.recovered", { payload: { count: touched.size, ms: Date.now() - t0 } }));
		return { missions: touched.size, ms: Date.now() - t0 };
	}

	return {
		createMission,
		start,
		verify,
		proposePlan,
		markStep,
		askUser,
		suggestMemory,
		followUp,
		steer,
		answer,
		pause,
		resume,
		cancel,
		emergencyStop,
		clearEmergency,
		confirm,
		archive,
		decideApproval,
		resolveUnknown,
		recover,
		missionView: (id) => repo.get(id),
		running: () => [...runs.keys()],
		/** Called by the broker when an approval is requested or decided. */
		onWaiting(missionId, kind, info) {
			commit(() => {
				const m = repo.get(missionId);
				if (!m || TERMINAL_STATES.has(m.status)) return;
				if (kind === "approval" && m.status === "running") setStatus(missionId, "waiting-approval", "approval");
				if (kind === "resource" && ["running", "verifying"].includes(m.status)) {
					setStatus(missionId, "waiting-resource", info?.reason ?? "budget");
					repo.setWaiting(missionId, { kind: "resource", reason: info?.reason?.startsWith("budget") ? "This mission used its budget. Extend it to continue." : "Waiting for resources" });
				}
			});
			if (kind === "resource") runtime.abort(missionId).catch(() => {});
		},
		onResumed(missionId) {
			commit(() => {
				const m = repo.get(missionId);
				if (m?.status === "waiting-approval" && approvals.pending(missionId).length === 0) setStatus(missionId, "running", "decided");
			});
		},
		onReconcileNeeded(missionId) {
			// The run continues (the model was told not to retry); settle() keeps the mission in needs-reconciliation.
			commit(() => {
				const m = repo.get(missionId);
				if (m && ["running", "verifying"].includes(m.status)) setStatus(missionId, "needs-reconciliation", "an action's outcome is unknown");
			});
		},
		extendBudget(missionId) {
			const b = budgets.extend(missionId, 2);
			commit(() => emit("budget.updated", { missionId, payload: { text: budgets.describe(b), spent: b.spent, limits: b.limits } }));
			const m = repo.get(missionId);
			if (m.status === "waiting-resource") enqueue(missionId, { input: `[Midnight] The user extended the budget. ${progressNote(missionId)} Continue.`, requestId: newId("req"), resume: true });
			return { ok: true };
		},
	};
}

function mergeSignals(a, b) {
	if (!a) return b;
	if (!b) return a;
	return AbortSignal.any([a, b]);
}
