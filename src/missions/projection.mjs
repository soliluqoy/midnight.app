// Deterministic projection of the domain journal into the views the capsule renders (plan ch. 04, 05, R03).
// Same events in, same state out: a snapshot at seq S plus the events after S equals a replay from zero.
// Content (answers, excerpts) is referenced, not embedded; the host resolves refs when it sends a view.

const FEED_MAX = 60;

export const emptyProjection = () => ({ seq: 0, missions: {}, approvals: {}, notifications: {}, screen: null, recovered: [] });

const clone = (s) => structuredClone(s);

function mission(state, id) {
	return (state.missions[id] ??= {
		id,
		title: "",
		goal: "",
		label: "MISSION",
		mode: "ask",
		privacy: "cloud",
		status: "draft",
		createdAt: "",
		updatedAt: "",
		runs: 0,
		runId: undefined,
		plan: { revision: 0, summary: "", nodes: [], checks: [], usesComputer: false },
		steps: {},
		actions: {},
		feed: [],
		approvals: [],
		questions: [],
		artifacts: {},
		evidence: 0,
		calculations: 0,
		sites: [],
		answerRef: undefined,
		checks: [],
		outcome: undefined,
		waiting: undefined,
		budget: undefined,
		recovery: undefined,
		trigger: { kind: "user" },
	});
}

const feed = (m, at, icon, cls, text) => {
	m.feed.push({ at, icon, cls, text });
	if (m.feed.length > FEED_MAX) m.feed.splice(0, m.feed.length - FEED_MAX);
};

/** Apply one event. Pure: returns a new state object (input is not mutated). */
export function reduce(prev, e) {
	const s = clone(prev);
	applyInPlace(s, e);
	return s;
}

/** Fold many events efficiently (one clone). */
export function reduceAll(prev, events) {
	const s = clone(prev);
	for (const e of events) applyInPlace(s, e);
	return s;
}

function applyInPlace(s, e) {
	if (e.seq <= s.seq) return; // idempotent under replay
	s.seq = e.seq;
	const p = e.payload ?? {};
	const at = e.occurredAt;
	const m = e.missionId ? mission(s, e.missionId) : undefined;
	if (m) m.updatedAt = at;
	switch (e.type) {
		case "mission.created":
			Object.assign(m, { title: p.title, goal: p.goal, label: p.label ?? "MISSION", mode: p.mode ?? "ask", privacy: p.privacy ?? "cloud", status: p.status ?? "queued", createdAt: at, trigger: p.trigger ?? { kind: "user" }, skill: p.skill });
			break;
		case "mission.titled":
			m.title = p.title;
			break;
		case "mission.state":
			m.status = p.to;
			if (!p.to.startsWith("waiting")) m.waiting = undefined;
			if (p.to === "queued" || p.to === "running") m.outcome = p.to === "queued" ? undefined : m.outcome;
			break;
		case "mission.waiting":
			m.waiting = { kind: p.kind, reason: p.reason ?? "", until: p.until, question: p.question };
			break;
		case "mission.archived":
			m.archived = !!p.archived;
			break;
		case "run.started":
			m.runs += 1;
			m.runId = e.runId;
			m.outcome = undefined;
			m.checks = [];
			m.recovery = undefined;
			m.lastInput = p.input;
			if (p.followUp) feed(m, at, "▸", "act", `follow-up · ${String(p.input ?? "").slice(0, 60)}`);
			break;
		case "run.settled":
			m.settledReason = p.reason;
			break;
		case "plan.revised":
			m.plan = { revision: p.revision, summary: p.summary ?? "", nodes: p.nodes ?? [], checks: p.checks ?? [], usesComputer: !!p.usesComputer, reason: p.reason };
			m.steps = {};
			for (const n of m.plan.nodes) m.steps[n.id] = { state: "todo", note: "" };
			if (p.revision > 1) feed(m, at, "↻", "look", `plan revised · ${p.reason ?? ""}`.trim());
			break;
		case "step.state":
			m.steps[p.nodeId] = { state: p.state, note: p.note ?? "" };
			break;
		case "action.prepared": {
			m.actions[p.intentId] = { tool: p.tool, effect: p.effect, target: p.target, label: p.label, state: "prepared" };
			const [icon, cls] = p.effect?.startsWith("read") || p.effect === "desktop.observe" || p.effect === "browser.navigate" ? ["◎", "look"] : p.effect === "compute" ? ["∑", "look"] : ["▸", "act"];
			feed(m, at, p.icon ?? icon, cls, p.label ?? `${p.tool} › ${p.target}`);
			if (p.effect === "read.web" || p.effect === "browser.navigate") {
				for (const h of hosts(p.target)) if (!m.sites.includes(h) && m.sites.length < 40) m.sites.push(h);
			}
			break;
		}
		case "action.dispatched":
			if (m.actions[p.intentId]) m.actions[p.intentId].state = "dispatching";
			break;
		case "action.reconciled": {
			const a = (m.actions[p.intentId] ??= { tool: p.tool, effect: p.effect, label: p.tool });
			a.state = p.state;
			a.remoteId = p.remoteId;
			if (p.state === "unknown") feed(m, at, "?", "warn", `${a.label ?? a.tool} · outcome unknown, checking`);
			else if (p.state === "failed") feed(m, at, "!", "warn", `${a.label ?? a.tool} failed`);
			else if (p.state === "rehearsed") feed(m, at, "◌", "look", `${a.label ?? a.tool} · rehearsed, nothing changed`);
			else if (a.effect && !a.effect.startsWith("read") && !["compute", "browser.navigate", "desktop.observe"].includes(a.effect)) feed(m, at, "✓", "ok", `${a.label ?? a.tool} · ${p.state}`);
			break;
		}
		case "action.denied":
			if (m.actions[p.intentId]) m.actions[p.intentId].state = "denied";
			feed(m, at, "✕", "warn", `blocked · ${p.reason}`);
			break;
		case "approval.requested":
			s.approvals[p.approvalId] = { id: p.approvalId, missionId: e.missionId, intentId: p.intentId, nonce: p.nonce, intentHash: p.intentHash, display: p.display, expiresAt: p.expiresAt, status: "pending" };
			if (!m.approvals.includes(p.approvalId)) m.approvals.push(p.approvalId);
			feed(m, at, "!", "warn", `needs your OK · ${p.display?.title ?? "an action"}`);
			break;
		case "approval.recorded": {
			const a = s.approvals[p.approvalId];
			if (a) a.status = p.status;
			m.approvals = m.approvals.filter((id) => id !== p.approvalId);
			feed(m, at, p.status === "approved" ? "✓" : "✕", p.status === "approved" ? "ok" : "warn", `${p.status === "approved" ? "approved" : p.decision === "keep-draft" ? "kept as draft" : p.status} · ${a?.display?.title ?? ""}`);
			break;
		}
		case "artifact.validated":
			m.artifacts[p.artifactId] = { id: p.artifactId, name: p.name, type: p.type, revision: p.revision, hash: p.hash, ok: !!p.ok, issues: p.issues ?? [], path: p.path, publishedPath: m.artifacts[p.artifactId]?.publishedPath };
			feed(m, at, p.ok ? "✓" : "!", p.ok ? "ok" : "warn", `${p.name} r${p.revision} · ${p.ok ? "validated" : "did not validate"}`);
			break;
		case "artifact.published":
			if (m.artifacts[p.artifactId]) m.artifacts[p.artifactId].publishedPath = p.path;
			feed(m, at, "✓", "ok", `saved · ${p.path}`);
			break;
		case "evidence.recorded":
			m.evidence += p.count ?? 1;
			if (p.kind === "calculation") m.calculations += p.count ?? 1;
			break;
		case "answer.recorded":
			m.answerRef = p.ref;
			m.answerChars = p.chars;
			break;
		case "verification.passed":
		case "verification.failed":
			m.checks = p.results ?? [];
			break;
		case "mission.completed":
			m.outcome = { status: p.status, summary: p.summary ?? "", passed: p.passed ?? [], missing: p.missing ?? [], at };
			break;
		case "budget.updated":
			m.budget = { text: p.text, spent: p.spent, limits: p.limits };
			break;
		case "notification.created":
			s.notifications[p.id] = { id: p.id, title: p.title, reason: p.reason, severity: p.severity, missionId: e.missionId || undefined, watchId: p.watchId, status: p.status ?? "queued", at, suggested: p.suggested, group: p.group };
			break;
		case "notification.updated":
			if (s.notifications[p.id]) s.notifications[p.id].status = p.status;
			break;
		case "lease.changed":
			s.screen = p.holder ? { missionId: p.holder, epoch: p.epoch, title: p.title } : null;
			break;
		case "system.recovered":
			if (m) m.recovery = { finished: p.finished ?? [], uncertain: p.uncertain ?? [], next: p.next ?? "" };
			else s.recovered.push({ at, count: p.count ?? 0 });
			break;
		default:
			break;
	}
}

function hosts(target) {
	return String(target ?? "")
		.split(/[\s,]+/)
		.map((u) => {
			try {
				return new URL(/^[a-z]+:\/\//i.test(u) ? u : `https://${u}`).host.replace(/^www\./, "");
			} catch {
				return "";
			}
		})
		.filter((h) => h && h.includes("."));
}

/** Group missions for the mission stack (Active / Needs you / Watching / History). */
export function stackOf(state) {
	const list = Object.values(state.missions).filter((m) => !m.archived);
	const by = (a, b) => (a.updatedAt < b.updatedAt ? 1 : -1);
	return {
		needsYou: list.filter((m) => ["waiting-input", "waiting-approval", "needs-reconciliation"].includes(m.status)).sort(by),
		active: list.filter((m) => ["queued", "planning", "ready", "running", "verifying", "recovering", "waiting-resource", "waiting-time", "paused"].includes(m.status)).sort(by),
		history: list.filter((m) => ["succeeded", "partially-succeeded", "failed", "cancelled", "draft"].includes(m.status)).sort(by).slice(0, 50),
	};
}
