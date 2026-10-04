// Domain vocabulary shared by the host, the shell and the renderer adapter. No Electron or Pi imports here:
// contracts sit at the bottom of the dependency graph (test/architecture.test.mjs enforces it).

export const SCHEMA_VERSION = 1; // event envelope version (MidnightEvent.schemaVersion)

/** Mission lifecycle (plan ch. 05). Transitions are enforced by `assertMissionTransition`. */
export const MISSION_STATES = [
	"draft",
	"queued",
	"planning",
	"ready",
	"running",
	"verifying",
	"waiting-input",
	"waiting-approval",
	"waiting-resource",
	"waiting-time",
	"paused",
	"recovering",
	"needs-reconciliation",
	"succeeded",
	"partially-succeeded",
	"failed",
	"cancelled",
	"archived",
];

const WAITING = ["waiting-input", "waiting-approval", "waiting-resource", "waiting-time"];
export const TERMINAL_STATES = new Set(["succeeded", "partially-succeeded", "failed", "cancelled"]);
export const ACTIVE_STATES = new Set(["queued", "planning", "ready", "running", "verifying", "recovering"]);
export const NEEDS_YOU_STATES = new Set(["waiting-input", "waiting-approval", "needs-reconciliation"]);

const T = {
	draft: ["queued", "cancelled", "archived"],
	queued: ["planning", "running", "paused", "cancelled", "waiting-resource", "waiting-time"],
	planning: ["ready", "running", "waiting-input", "waiting-approval", "waiting-resource", "paused", "cancelled", "failed", "recovering"],
	ready: ["running", "queued", "paused", "cancelled"],
	running: ["verifying", "planning", "queued", ...WAITING, "paused", "cancelled", "failed", "recovering", "needs-reconciliation"],
	verifying: ["succeeded", "partially-succeeded", "failed", "running", "planning", "waiting-input", "needs-reconciliation", "recovering", "cancelled"],
	"waiting-input": ["queued", "running", "planning", "paused", "cancelled", "failed", "partially-succeeded", "recovering"],
	"waiting-approval": ["queued", "running", "paused", "cancelled", "recovering", "partially-succeeded", "failed"],
	"waiting-resource": ["queued", "running", "paused", "cancelled", "recovering", "partially-succeeded"],
	"waiting-time": ["queued", "running", "paused", "cancelled", "recovering"],
	paused: ["queued", "cancelled", "recovering", "archived"],
	recovering: ["queued", "running", "planning", "needs-reconciliation", ...WAITING, "paused", "failed", "cancelled", "partially-succeeded"],
	"needs-reconciliation": ["queued", "running", "recovering", "partially-succeeded", "failed", "cancelled"],
	succeeded: ["archived", "queued"], // queued = a follow-up starts a new run of the same mission
	"partially-succeeded": ["archived", "queued"],
	failed: ["archived", "queued"],
	cancelled: ["archived", "queued"],
	archived: ["queued"],
};

export function canTransitionMission(from, to) {
	return from === to || (T[from] ?? []).includes(to);
}
export function assertMissionTransition(from, to) {
	if (!canTransitionMission(from, to)) throw new Error(`illegal mission transition ${from} -> ${to}`);
}

/** Action protocol states (plan ch. 06): prepare -> authorize -> reserve -> dispatch -> reconcile -> verify -> receipt. */
export const ACTION_STATES = ["prepared", "waiting-approval", "authorized", "dispatching", "acknowledged", "verifying", "verified", "failed", "unknown", "compensated", "denied", "cancelled"];
const A = {
	prepared: ["waiting-approval", "authorized", "denied", "cancelled"],
	"waiting-approval": ["authorized", "denied", "cancelled"],
	authorized: ["dispatching", "cancelled", "denied"],
	dispatching: ["acknowledged", "verified", "failed", "unknown"],
	acknowledged: ["verifying", "verified", "failed", "unknown"],
	verifying: ["verified", "failed", "unknown"],
	unknown: ["verified", "failed", "unknown", "compensated"],
	verified: ["compensated"],
	failed: [],
	compensated: [],
	denied: [],
	cancelled: [],
};
export const ACTION_FINAL = new Set(["verified", "failed", "compensated", "denied", "cancelled"]);
export function canTransitionAction(from, to) {
	return (A[from] ?? []).includes(to);
}

/**
 * Effect classes are Midnight's own classification (server annotations are only hints).
 * `reversible` local effects can be prepared without approval in "Prepare for me";
 * everything that leaves the machine needs a matching grant or an exact approval.
 */
export const EFFECTS = {
	"read.local": { external: false, reversible: true, label: "read local files" },
	"read.web": { external: false, reversible: true, label: "read public web pages" },
	"read.connector": { external: false, reversible: true, label: "read connected account data" },
	"compute": { external: false, reversible: true, label: "calculate" },
	"artifact.stage": { external: false, reversible: true, label: "create a draft in the mission workspace" },
	"local.write": { external: false, reversible: true, label: "write files in a chosen folder" },
	"local.move": { external: false, reversible: true, label: "move files (with an undo manifest)" },
	"local.delete": { external: false, reversible: false, label: "delete files" },
	"browser.navigate": { external: false, reversible: true, label: "open pages in midnight's browser" },
	"browser.commit": { external: true, reversible: false, label: "submit a form or press a commit button on a website" },
	"desktop.observe": { external: false, reversible: true, label: "look at your screen" },
	"desktop.input": { external: false, reversible: false, label: "use your mouse and keyboard" },
	"external.communication": { external: true, reversible: false, label: "send a message" },
	"connector.write": { external: true, reversible: false, label: "change records in a connected account" },
	"external.purchase": { external: true, reversible: false, label: "buy or book something" },
	"open.user": { external: false, reversible: true, label: "open something for you to see" },
};
export const isExternal = (effect) => !!EFFECTS[effect]?.external;

/** Autonomy modes (plan ch. 07). */
export const MODES = {
	ask: { label: "Ask me", autoEffects: ["read.local", "read.web", "read.connector", "compute", "browser.navigate", "desktop.observe", "open.user", "artifact.stage"] },
	prepare: { label: "Prepare for me", autoEffects: ["read.local", "read.web", "read.connector", "compute", "browser.navigate", "desktop.observe", "open.user", "artifact.stage"] },
	rules: { label: "Act within my rules", autoEffects: ["read.local", "read.web", "read.connector", "compute", "browser.navigate", "desktop.observe", "open.user", "artifact.stage"] },
};

/**
 * Deterministic outcome checks the coordinator evaluates after the runtime settles.
 * A model can propose checks from this vocabulary; only Midnight decides whether they passed.
 */
export const CHECK_KINDS = {
	answer: "A final answer was delivered",
	citations: "Every cited web source was actually read during this mission",
	artifact: "A validated artifact was produced",
	receipt: "An external effect has a verified receipt",
	file: "A file exists at the published path with the recorded hash",
	evidence: "The claim is tied to recorded evidence",
	calculation: "Numbers come from a deterministic calculation",
	confirm: "You confirm the result",
};

/** Canonical domain event types (plan ch. 05). Text output is content, never mission.completed. */
export const EVENT_TYPES = [
	"mission.created",
	"mission.state",
	"mission.titled",
	"mission.waiting",
	"mission.completed",
	"mission.archived",
	"run.started",
	"run.settled",
	"plan.revised",
	"step.started",
	"step.state",
	"action.prepared",
	"approval.requested",
	"approval.recorded",
	"action.dispatched",
	"action.reconciled",
	"action.denied",
	"artifact.validated",
	"artifact.published",
	"evidence.recorded",
	"verification.passed",
	"verification.failed",
	"answer.recorded",
	"budget.updated",
	"grant.created",
	"grant.revoked",
	"watch.checked",
	"watch.changed",
	"watch.updated",
	"watch.deleted",
	"notification.created",
	"notification.updated",
	"lease.changed",
	"memory.changed",
	"system.recovered",
	"system.stopped",
];
