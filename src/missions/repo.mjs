// Mission persistence (plan ch. 05). Every write here happens inside the caller's unit of work and emits the
// domain event that describes it, so the journal and the tables never disagree.
import { assertMissionTransition } from "../contracts/domain.mjs";
import { newId } from "../contracts/events.mjs";
import { json } from "../storage/db.mjs";

export function createMissionRepo(store, emit) {
	const row = (r) =>
		r && {
			id: r.id,
			title: r.title,
			goal: r.goal,
			nonGoals: json(r.non_goals, []),
			owner: r.owner,
			trigger: json(r.trigger, { kind: "user" }),
			status: r.status,
			priority: r.priority,
			deadline: r.deadline ?? undefined,
			scope: json(r.scope, {}),
			mode: r.mode,
			modelPolicy: json(r.model_policy, {}),
			privacy: json(r.model_policy, {}).privacy ?? "cloud",
			dryRun: !!json(r.scope, {}).dryRun,
			budgetId: r.budget_id ?? undefined,
			conversation: r.conversation ?? undefined,
			planRevision: r.plan_revision,
			skill: r.skill ?? undefined,
			watchId: r.watch_id ?? undefined,
			outcome: json(r.outcome, {}),
			waiting: json(r.waiting, {}),
			createdAt: r.created_at,
			updatedAt: r.updated_at,
			archived: !!r.archived,
		};
	const now = () => new Date().toISOString();

	const api = {
		create({ title, goal, mode = "ask", privacy = "cloud", trigger = { kind: "user" }, skill, watchId, priority = 0, label, dryRun = false, scope = {} }) {
			const id = newId("msn");
			const at = now();
			store.run(
				"INSERT INTO missions (id, title, goal, trigger, status, priority, scope, mode, model_policy, skill, watch_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)",
				id,
				title.slice(0, 200),
				goal,
				JSON.stringify(trigger),
				priority,
				JSON.stringify({ ...scope, dryRun }),
				mode,
				JSON.stringify({ privacy }),
				skill ?? null,
				watchId ?? null,
				at,
				at,
			);
			emit("mission.created", { missionId: id, payload: { title, goal: goal.slice(0, 2000), mode, privacy, trigger, skill, label, status: "queued" } });
			return api.get(id);
		},
		get: (id) => row(store.get("SELECT * FROM missions WHERE id = ?", id)),
		list: ({ includeArchived = false, limit = 200 } = {}) =>
			store.all(`SELECT * FROM missions ${includeArchived ? "" : "WHERE archived = 0"} ORDER BY updated_at DESC LIMIT ?`, limit).map(row),
		withStatus: (...states) => store.all(`SELECT * FROM missions WHERE status IN (${states.map(() => "?").join(",")})`, ...states).map(row),
		setStatus(id, to, reason = "") {
			const m = api.get(id);
			if (!m) throw new Error(`no mission ${id}`);
			if (m.status === to) return m;
			assertMissionTransition(m.status, to);
			store.run("UPDATE missions SET status = ?, updated_at = ? WHERE id = ?", to, now(), id);
			emit("mission.state", { missionId: id, payload: { from: m.status, to, reason } });
			return api.get(id);
		},
		setWaiting(id, waiting) {
			store.run("UPDATE missions SET waiting = ?, updated_at = ? WHERE id = ?", JSON.stringify(waiting ?? {}), now(), id);
			if (waiting?.kind) emit("mission.waiting", { missionId: id, payload: waiting });
		},
		setTitle(id, title) {
			store.run("UPDATE missions SET title = ? WHERE id = ?", title.slice(0, 200), id);
			emit("mission.titled", { missionId: id, payload: { title } });
		},
		setConversation(id, file) {
			store.run("UPDATE missions SET conversation = ? WHERE id = ?", file, id);
		},
		setBudget(id, budgetId) {
			store.run("UPDATE missions SET budget_id = ? WHERE id = ?", budgetId, id);
		},
		setOutcome(id, outcome) {
			store.run("UPDATE missions SET outcome = ?, updated_at = ? WHERE id = ?", JSON.stringify(outcome), now(), id);
		},
		setArchived(id, archived) {
			store.run("UPDATE missions SET archived = ? WHERE id = ?", archived ? 1 : 0, id);
			emit("mission.archived", { missionId: id, payload: { archived } });
		},

		// ---- runs (one per submitted input; request IDs deduplicate retries) ----
		runByRequest: (requestId) => store.get("SELECT * FROM runs WHERE request_id = ?", requestId),
		startRun({ missionId, requestId, input, runtimeVersion, modelRoute = {}, followUp = false }) {
			const existing = api.runByRequest(requestId);
			if (existing) return { id: existing.id, duplicate: true };
			const id = newId("run");
			store.run(
				"INSERT INTO runs (id, mission_id, request_id, input, started_at, runtime_version, model_route) VALUES (?, ?, ?, ?, ?, ?, ?)",
				id,
				missionId,
				requestId,
				input.slice(0, 20000),
				now(),
				runtimeVersion,
				JSON.stringify(modelRoute),
			);
			emit("run.started", { missionId, runId: id, payload: { input: input.slice(0, 300), followUp, model: modelRoute.model } });
			return { id, duplicate: false };
		},
		endRun(runId, { outcome, recoveryReason } = {}) {
			store.run("UPDATE runs SET ended_at = ?, outcome = ?, recovery_reason = ? WHERE id = ? AND ended_at IS NULL", now(), outcome ?? null, recoveryReason ?? null, runId);
		},
		openRuns: () => store.all("SELECT * FROM runs WHERE ended_at IS NULL"),
		runs: (missionId) => store.all("SELECT * FROM runs WHERE mission_id = ? ORDER BY started_at", missionId),

		// ---- plans ----
		addPlan(missionId, plan, reason) {
			const m = api.get(missionId);
			const revision = m.planRevision + 1;
			store.run(
				"INSERT INTO plan_revisions (mission_id, revision, prior_revision, summary, assumptions, evidence_refs, nodes, checks, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				missionId,
				revision,
				m.planRevision || null,
				plan.summary ?? "",
				JSON.stringify(plan.assumptions ?? []),
				JSON.stringify(plan.evidenceRefs ?? []),
				JSON.stringify(plan.nodes),
				JSON.stringify(plan.checks),
				reason,
				now(),
			);
			store.run("UPDATE missions SET plan_revision = ? WHERE id = ?", revision, missionId);
			for (const n of plan.nodes) store.run("INSERT INTO step_states (mission_id, revision, node_id, state, updated_at) VALUES (?, ?, ?, 'todo', ?)", missionId, revision, n.id, now());
			emit("plan.revised", { missionId, payload: { revision, summary: plan.summary, nodes: plan.nodes, checks: plan.checks, usesComputer: !!plan.usesComputer, reason } });
			return revision;
		},
		plan(missionId) {
			const r = store.get("SELECT * FROM plan_revisions WHERE mission_id = ? ORDER BY revision DESC LIMIT 1", missionId);
			return r && { revision: r.revision, summary: r.summary, nodes: json(r.nodes, []), checks: json(r.checks, []), reason: r.reason };
		},
		setStep(missionId, nodeId, state, note = "") {
			const m = api.get(missionId);
			const r = store.run("UPDATE step_states SET state = ?, note = ?, updated_at = ? WHERE mission_id = ? AND revision = ? AND node_id = ?", state, note.slice(0, 300), now(), missionId, m.planRevision, nodeId);
			if (r.changes) emit("step.state", { missionId, payload: { nodeId, state, note } });
			return r.changes > 0;
		},
		steps: (missionId) => {
			const m = api.get(missionId);
			return store.all("SELECT * FROM step_states WHERE mission_id = ? AND revision = ?", missionId, m?.planRevision ?? 0);
		},

		// ---- questions the model asks the user ----
		ask(missionId, prompt, options = []) {
			const id = newId("q");
			store.run("INSERT INTO questions (id, mission_id, prompt, options, created_at) VALUES (?, ?, ?, ?, ?)", id, missionId, prompt.slice(0, 2000), JSON.stringify(options.slice(0, 8)), now());
			return id;
		},
		question: (id) => {
			const r = store.get("SELECT * FROM questions WHERE id = ?", id);
			return r && { id: r.id, missionId: r.mission_id, prompt: r.prompt, options: json(r.options, []), answer: r.answer ?? undefined };
		},
		openQuestions: (missionId) =>
			store.all("SELECT * FROM questions WHERE mission_id = ? AND answer IS NULL ORDER BY created_at", missionId).map((r) => ({ id: r.id, prompt: r.prompt, options: json(r.options, []) })),
		answer(id, value) {
			return store.run("UPDATE questions SET answer = ?, answered_at = ? WHERE id = ? AND answer IS NULL", value.slice(0, 4000), now(), id).changes > 0;
		},
	};
	return api;
}
