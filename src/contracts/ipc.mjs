// Versioned renderer -> shell IPC contract. The preload exposes one named function per method; the shell validates
// sender, origin, version, sequence, size and schema before anything runs (src/desktop/ipc.mjs). There is no
// generic "execute" method: every capability the renderer has is listed here.
import { Type } from "typebox";
import { Value } from "typebox/value";

export const IPC_VERSION = 1;
export const IPC_CHANNEL = "midnight:v1";
export const EVENT_CHANNEL = "midnight:ev";
export const MAX_REQUEST_BYTES = 64 * 1024;

const Id = Type.String({ minLength: 1, maxLength: 80, pattern: "^[A-Za-z0-9_.:-]+$" });
const Text = (max = 20000) => Type.String({ maxLength: max });
const Obj = (props) => Type.Object(props, { additionalProperties: false });
const None = Obj({});

const SizeState = Type.Union(["idle", "chat", "mission", "settings", "read", "stack"].map((s) => Type.Literal(s)));
const Decision = Type.Union(["approve", "decline", "keep-draft", "allow-routine"].map((s) => Type.Literal(s)));
const Effect = Type.String({ maxLength: 40 });

export const GrantDraft = Obj({
	label: Text(120),
	actionClasses: Type.Array(Effect, { minItems: 1, maxItems: 8 }),
	account: Type.Optional(Text(200)),
	roots: Type.Optional(Type.Array(Text(1000), { maxItems: 16 })),
	destinations: Type.Optional(Type.Array(Text(320), { maxItems: 32 })),
	limits: Type.Optional(Obj({ maxActions: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000 })), maxSpendUsd: Type.Optional(Type.Number({ minimum: 0, maximum: 100000 })) })),
	schedule: Type.Optional(Text(200)),
	expiresInDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 366 })),
	missionId: Type.Optional(Id),
});

export const WatchDraft = Obj({
	label: Text(120),
	source: Obj({
		kind: Type.Union([Type.Literal("folder"), Type.Literal("url"), Type.Literal("connector")]),
		path: Type.Optional(Text(1000)),
		url: Type.Optional(Text(2000)),
		connector: Type.Optional(Text(80)),
		query: Type.Optional(Text(2000)),
	}),
	every: Obj({ unit: Type.Union([Type.Literal("minutes"), Type.Literal("hours"), Type.Literal("days"), Type.Literal("weekdays")]), n: Type.Integer({ minimum: 1, maximum: 1440 }), at: Type.Optional(Text(5)) }),
	threshold: Type.Optional(Obj({ minChanges: Type.Optional(Type.Integer({ minimum: 1, maximum: 100000 })), field: Type.Optional(Text(80)), minDelta: Type.Optional(Type.Number()) })),
	cooldownMinutes: Type.Optional(Type.Integer({ minimum: 0, maximum: 10080 })),
	onChange: Type.Optional(Type.Union([Type.Literal("notify"), Type.Literal("prepare")])),
	prompt: Type.Optional(Text(4000)),
	expiresInDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 366 })),
});

/** method -> { route: "shell" | "host", params } */
export const METHODS = {
	// shell-local: window, clipboard, settings, sign-in
	"ui.size": { route: "shell", params: Obj({ state: SizeState }) },
	"ui.dims": { route: "shell", params: None },
	"ui.focus": { route: "shell", params: None },
	"ui.textSize": { route: "shell", params: Obj({ z: Type.Number({ minimum: 0.5, maximum: 2 }) }) },
	"clipboard.read": { route: "shell", params: None },
	"clipboard.write": { route: "shell", params: Obj({ text: Text(200000) }) },
	"open.external": { route: "shell", params: Obj({ url: Text(4000) }) },
	"browser.peek": { route: "shell", params: None },
	"settings.get": { route: "shell", params: None },
	"settings.set": { route: "shell", params: Obj({ patch: Type.Record(Type.String({ maxLength: 40 }), Type.Unknown()) }) },
	"auth.login": { route: "shell", params: Obj({ provider: Id, type: Type.Union([Type.Literal("oauth"), Type.Literal("api_key")]), key: Type.Optional(Text(4000)) }) },
	"auth.cancel": { route: "shell", params: None },
	"auth.logout": { route: "shell", params: Obj({ provider: Id }) },
	"auth.answer": { route: "shell", params: Obj({ promptId: Id, value: Type.Union([Text(4000), Type.Null()]) }) },
	"data.clearBrowser": { route: "shell", params: None },
	"data.openFolder": { route: "shell", params: None },
	"sources.pick": { route: "shell", params: Obj({ purpose: Type.Union([Type.Literal("source"), Type.Literal("output")]) }) },
	"diagnostics.save": { route: "shell", params: None },
	"engine.restart": { route: "shell", params: None },
	"update.check": { route: "shell", params: None },
	"update.install": { route: "shell", params: None },

	// host: missions, decisions, rules, memory, history
	"mission.create": { route: "host", params: Obj({ text: Text(), requestId: Id, mode: Type.Optional(Type.Union(["ask", "prepare", "rules"].map((m) => Type.Literal(m)))), skill: Type.Optional(Id), privacy: Type.Optional(Type.Union(["cloud", "local", "offline"].map((m) => Type.Literal(m)))) }) },
	"mission.followUp": { route: "host", params: Obj({ missionId: Id, text: Text(), requestId: Id }) },
	"mission.steer": { route: "host", params: Obj({ missionId: Id, text: Text() }) },
	"mission.pause": { route: "host", params: Obj({ missionId: Id }) },
	"mission.resume": { route: "host", params: Obj({ missionId: Id }) },
	"mission.cancel": { route: "host", params: Obj({ missionId: Id }) },
	"mission.archive": { route: "host", params: Obj({ missionId: Id }) },
	"mission.confirm": { route: "host", params: Obj({ missionId: Id, checkId: Id, ok: Type.Boolean() }) },
	"mission.answer": { route: "host", params: Obj({ missionId: Id, questionId: Id, value: Text(4000) }) },
	"mission.saveRecipe": { route: "host", params: Obj({ missionId: Id, label: Text(120) }) },
	"mission.extendBudget": { route: "host", params: Obj({ missionId: Id }) },
	"mission.resolveUnknown": { route: "host", params: Obj({ missionId: Id, intentId: Id, outcome: Type.Union([Type.Literal("happened"), Type.Literal("did-not-happen")]) }) },
	"mission.checkAgain": { route: "host", params: Obj({ missionId: Id, intentId: Id }) },
	"recipe.list": { route: "host", params: None },
	"recipe.review": { route: "host", params: Obj({ recipeId: Id }) },
	"recipe.run": { route: "host", params: Obj({ recipeId: Id, requestId: Id }) },
	"skill.list": { route: "host", params: None },
	"connector.list": { route: "host", params: None },
	"memory.confirm": { route: "host", params: Obj({ memoryId: Id }) },
	"stop.emergency": { route: "host", params: None },
	"stop.clear": { route: "host", params: None },
	"proactive.pause": { route: "host", params: Obj({ paused: Type.Boolean() }) },
	"approval.displayed": { route: "host", params: Obj({ approvalId: Id, nonce: Id }) },
	"approval.decide": { route: "host", params: Obj({ approvalId: Id, nonce: Id, intentHash: Type.String({ maxLength: 100 }), decision: Decision }) },
	"grant.create": { route: "host", params: Obj({ draft: GrantDraft }) },
	"grant.revoke": { route: "host", params: Obj({ grantId: Id }) },
	"grant.list": { route: "host", params: None },
	"watch.create": { route: "host", params: Obj({ draft: WatchDraft }) },
	"watch.setPaused": { route: "host", params: Obj({ watchId: Id, paused: Type.Boolean() }) },
	"watch.delete": { route: "host", params: Obj({ watchId: Id }) },
	"watch.list": { route: "host", params: None },
	"notification.act": { route: "host", params: Obj({ notificationId: Id, action: Type.Union(["do", "later", "not-useful", "never", "dismiss"].map((a) => Type.Literal(a))) }) },
	"memory.list": { route: "host", params: Obj({ query: Type.Optional(Text(400)) }) },
	"memory.remember": { route: "host", params: Obj({ text: Text(2000), kind: Type.Union([Type.Literal("preference"), Type.Literal("fact")]) }) },
	"memory.correct": { route: "host", params: Obj({ memoryId: Id, text: Text(2000) }) },
	"memory.forget": { route: "host", params: Obj({ memoryId: Id }) },
	"memory.export": { route: "host", params: None },
	"sources.list": { route: "host", params: None },
	"sources.remove": { route: "host", params: Obj({ rootId: Id }) },
	"artifact.open": { route: "host", params: Obj({ artifactId: Id, reveal: Type.Optional(Type.Boolean()) }) },
	"query.snapshot": { route: "host", params: None },
	"query.events": { route: "host", params: Obj({ afterSeq: Type.Integer({ minimum: 0 }) }) },
	"query.mission": { route: "host", params: Obj({ missionId: Id }) },
	"query.history": { route: "host", params: Obj({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })), before: Type.Optional(Type.String({ maxLength: 40 })) }) },
	"data.export": { route: "host", params: None },
	"data.delete": { route: "host", params: Obj({ scope: Type.Union(["history", "memory", "all"].map((s) => Type.Literal(s))) }) },
	"diagnostics.preview": { route: "host", params: None },
	"resources.status": { route: "host", params: None },
};

/**
 * Validate one request envelope. Returns { ok: true, method, params } or { ok: false, error }.
 * `lastSeq` enforces monotonic sequence numbers per renderer session (replays and reorders are rejected).
 */
export function validateRequest(envelope, { lastSeq = 0 } = {}) {
	if (!envelope || typeof envelope !== "object") return { ok: false, error: "malformed request" };
	if (envelope.v !== IPC_VERSION) return { ok: false, error: `unsupported IPC version ${envelope.v}` };
	let size = 0;
	try {
		size = JSON.stringify(envelope).length;
	} catch {
		return { ok: false, error: "request is not serializable" };
	}
	if (size > MAX_REQUEST_BYTES) return { ok: false, error: `request too large (${size} bytes)` };
	if (!Number.isInteger(envelope.seq) || envelope.seq <= lastSeq) return { ok: false, error: "out-of-order or replayed request" };
	const spec = Object.hasOwn(METHODS, envelope.method) ? METHODS[envelope.method] : undefined;
	if (!spec) return { ok: false, error: `unknown method ${String(envelope.method).slice(0, 40)}` };
	const params = envelope.params ?? {};
	if (!Value.Check(spec.params, params)) {
		const first = [...Value.Errors(spec.params, params)][0];
		return { ok: false, error: `invalid params for ${envelope.method}: ${first?.instancePath ?? ""} ${first?.message ?? ""}`.trim() };
	}
	return { ok: true, method: envelope.method, params, route: spec.route };
}
