// The universal tool broker (plan ch. 04, 06, P02/P03). Every tool call, whether the model calls it directly,
// finds it through tool search, or reaches it through Codemode, MCP or another tool's executeTool, enters here
// via the runtime's tool_call gate. Authority comes from the mission's mode, a matching grant, or an exact approval
// bound to the canonical intent; never from model prose.
//
//   gate():      classify -> canonical intent (persisted) -> authorize (mode | grant | exact approval) -> allow/block
//   execute():   reserve budget -> locks / screen lease -> recheck -> dispatch -> verify | reconcile -> receipt
import { EFFECTS, isExternal, MODES } from "../contracts/domain.mjs";
import { intentHash, sha256, stableStringify } from "./canonical.mjs";

const MUTATING = (effect) => !["read.local", "read.web", "read.connector", "compute", "artifact.stage", "browser.navigate", "desktop.observe", "open.user"].includes(effect);
const UNCERTAIN_CODES = new Set(["ETIMEDOUT", "ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT", "TIMEOUT"]);

export class BrokerDenied extends Error {
	constructor(reason, code = "denied") {
		super(reason);
		this.code = code;
	}
}

/**
 * @param {object} deps
 * @param {(fn: () => any) => any} deps.commit unit of work
 * @param {(type: string, fields: object) => object} deps.emit journal event inside commit
 */
export function createBroker(deps) {
	const { commit, emit, ledger, grants, approvals, budgets, locks, stop, missions, roots, tools, platform, journal, hooks = {} } = deps;
	const pending = new Map(); // toolCallId -> { intentId, spec, cls, args, missionId, runId }

	const block = (reason) => ({ block: true, reason: `Midnight did not run this: ${reason}` });

	function foreignSpec(name) {
		// Tools Midnight did not author (MCP, Codemode-discovered) are treated as account writes until reviewed:
		// server annotations are hints, not authority.
		return {
			name,
			version: "foreign",
			label: name,
			foreign: true,
			classify: (args) => ({
				effect: "connector.write",
				target: name,
				canonical: args,
				network: true,
				display: { title: `Run ${name}`, verb: "Run it", consequence: "A connected tool Midnight has not reviewed may change data in that account.", preview: stableStringify(args).slice(0, 600) },
			}),
		};
	}

	function authorityFor(mission, cls) {
		const effect = cls.effect;
		if (!EFFECTS[effect]) return { kind: "deny", reason: `unknown effect ${effect}` };
		const req = { effect, missionId: mission.id, account: cls.account, paths: cls.paths, destinations: cls.destinations, spendUsd: cls.spendUsd };
		// Anything that drives the screen needs desktop control from an approved plan, whatever else it needs.
		if (cls.screen && effect !== "desktop.input" && !grants.match({ effect: "desktop.input", missionId: mission.id })) {
			return { kind: "deny", reason: "using your screen needs a plan you approved with desktop control" };
		}
		// Desktop and screen access always need a mission-scoped grant from an approved plan.
		if (effect === "desktop.input" || effect === "desktop.observe") {
			const g = grants.match(req);
			return g ? { kind: "grant", grantId: g.id, grantVersion: g.version } : { kind: "deny", reason: "using your screen needs a plan you approved with desktop control" };
		}
		// Reading local files: only inside folders the user selected (sources or outputs).
		if (effect === "read.local") {
			const all = roots.list();
			if ((cls.paths ?? []).length && cls.paths.every((p) => all.some((r) => roots.covers(r, p)))) return { kind: "mode", reason: "selected folder" };
			return { kind: "approval", reason: "outside your selected folders" };
		}
		const g = grants.match(req);
		if (g) return { kind: "grant", grantId: g.id, grantVersion: g.version };
		const mode = MODES[mission.mode] ?? MODES.ask;
		if (mode.autoEffects.includes(effect)) return { kind: "mode", reason: mode.label };
		// "Prepare for me" and "Act within my rules" may write and move (never delete) inside chosen output folders.
		if ((effect === "local.write" || effect === "local.move") && mission.mode !== "ask") {
			const outs = roots.list().filter((r) => r.purpose === "output");
			if ((cls.paths ?? []).length && cls.paths.every((p) => outs.some((r) => roots.covers(r, p)))) return { kind: "mode", reason: "selected output folder" };
		}
		if (cls.approvable === false) return { kind: "deny", reason: cls.denyReason ?? "this action is not allowed" };
		return { kind: "approval", reason: "needs your OK" };
	}

	function displayFor(spec, cls) {
		const d = cls.display ?? {};
		return {
			title: d.title ?? `${spec.label}: ${cls.target}`,
			verb: d.verb ?? "Approve",
			decline: d.decline ?? "Decline",
			effect: cls.effect,
			effectLabel: EFFECTS[cls.effect]?.label ?? cls.effect,
			account: cls.account ?? d.account,
			recipients: d.recipients ?? cls.destinations ?? [],
			attachments: d.attachments ?? [],
			consequence: d.consequence ?? (isExternal(cls.effect) ? "This leaves your computer and cannot be undone by Midnight." : "This changes files on your computer."),
			preview: typeof d.preview === "string" ? d.preview.slice(0, 4000) : undefined,
			target: cls.target,
			routine: isExternal(cls.effect) || cls.effect === "local.move" || cls.effect === "local.write",
		};
	}

	function deny(intent, reason, code = "denied") {
		commit(() => {
			ledger.transition(intent.id, "denied");
			ledger.receipt(intent.id, { state: "denied", observed: { reason, code } });
			emit("action.denied", { missionId: intent.missionId, runId: intent.runId, correlationId: intent.id, payload: { intentId: intent.id, tool: intent.tool, effect: intent.effect, reason, code } });
		});
	}

	async function gate({ missionId, runId, toolCallId, toolName, input, signal }) {
		const spec = tools.get(toolName) ?? foreignSpec(toolName);
		const mission = missions.get(missionId);
		if (!mission) return block("there is no active mission for this call");
		const stopped = stop.blocked(missionId);
		if (stopped) return block(stopped);
		let cls;
		try {
			cls = await spec.classify(input ?? {}, { mission, roots });
		} catch (err) {
			return block(`the request is not valid (${err.message})`);
		}
		if ((mission.privacy === "offline" || mission.privacy === "local") && cls.network && !cls.localNetwork) {
			return block(`this mission is set to ${mission.privacy === "offline" ? "offline" : "local only"}; ${spec.label} would use the network. Tell the user what you could not do.`);
		}
		const argsHash = intentHash(spec.name, cls.canonical ?? input);
		const twin = ledger.blockingTwin(missionId, argsHash);
		if (twin) {
			hooks.reconcileNeeded?.(missionId, twin);
			return block("an identical earlier request may already have happened and is being checked. Do not retry it; tell the user it needs reconciling.");
		}
		if (isExternal(cls.effect) && !cls.repeatable && ledger.verifiedTwin(missionId, argsHash)) {
			return block("this exact action already happened earlier in this mission (it has a verified receipt). Do not repeat it.");
		}
		const intent = commit(() => {
			const argsRef = journal.putPayload(missionId, "intent-args", { tool: spec.name, args: input ?? {} });
			const i = ledger.prepare({ missionId, runId, tool: spec.name, toolVersion: spec.version ?? "1", effect: cls.effect, target: cls.target ?? "", argsHash, argsRef, display: displayFor(spec, cls) });
			emit("action.prepared", { missionId, runId, correlationId: i.id, payload: { intentId: i.id, tool: spec.name, effect: cls.effect, target: cls.target ?? "", label: cls.feed ?? spec.label, icon: cls.icon } });
			return i;
		});
		const auth = authorityFor(mission, cls);
		if (auth.kind === "deny") {
			deny(intent, auth.reason);
			return block(`${auth.reason}. Do not retry; tell the user.`);
		}
		if (auth.kind === "approval") {
			const approval = commit(() => {
				ledger.transition(intent.id, "waiting-approval");
				const a = approvals.request({ intentId: intent.id, missionId, intentHash: argsHash, display: { ...intent.display, why: auth.reason } });
				emit("approval.requested", { missionId, runId, correlationId: intent.id, payload: { approvalId: a.id, intentId: intent.id, nonce: a.nonce, intentHash: argsHash, display: a.display, expiresAt: a.expiresAt } });
				return a;
			});
			hooks.waiting?.(missionId, "approval", { approvalId: approval.id });
			const decided = await approvals.wait(approval.id, signal);
			hooks.resumed?.(missionId);
			if (decided.status !== "approved") {
				commit(() => {
					ledger.transition(intent.id, decided.status === "cancelled" ? "cancelled" : "denied");
					ledger.receipt(intent.id, { state: "denied", observed: { decision: decided.decision ?? decided.status } });
					emit("approval.recorded", { missionId, runId, correlationId: intent.id, payload: { approvalId: approval.id, intentId: intent.id, status: decided.status, decision: decided.decision } });
				});
				if (decided.decision === "keep-draft") return block("the user chose to keep this as a draft. Do not send it; tell them the draft is ready.");
				if (decided.status === "expired" || decided.status === "invalidated") return block(`the approval ${decided.status === "expired" ? "expired" : "no longer matches the action"}. Ask the user before trying a different action.`);
				return block("the user declined it. Do not retry; offer the safe alternative.");
			}
			let grantId;
			if (decided.decision === "allow-routine") {
				const g = grants.create(routineDraft(spec, cls, mission), "user:allow-routine");
				grantId = g.id;
				commit(() => emit("grant.created", { missionId, payload: { grantId: g.id, label: g.label } }));
			}
			commit(() => {
				ledger.transition(intent.id, "authorized", { authority: { kind: "approval", approvalId: approval.id, grantId } });
				emit("approval.recorded", { missionId, runId, correlationId: intent.id, payload: { approvalId: approval.id, intentId: intent.id, status: "approved", decision: decided.decision } });
			});
		} else {
			commit(() => ledger.transition(intent.id, "authorized", { authority: auth }));
		}
		pending.set(toolCallId, { intentId: intent.id, spec, cls, args: input ?? {}, missionId, runId });
		if (spec.foreign) {
			// We cannot see inside a foreign tool's execution, so it counts as dispatched from here on.
			const recheck = recheckReason(ledger.get(intent.id), cls, mission);
			if (recheck) {
				pending.delete(toolCallId);
				deny(ledger.get(intent.id), recheck);
				return block(recheck);
			}
			commit(() => {
				ledger.transition(intent.id, "dispatching");
				emit("action.dispatched", { missionId, runId, correlationId: intent.id, payload: { intentId: intent.id, tool: spec.name } });
			});
		}
		return undefined;
	}

	function recheckReason(intent, cls, mission) {
		const stopped = stop.blocked(intent.missionId);
		if (stopped) return stopped;
		const m = missions.get(intent.missionId);
		if (!m || ["cancelled", "paused"].includes(m.status)) return "the mission was paused or cancelled";
		const a = intent.authority ?? {};
		if (a.kind === "grant" && !grants.stillCovers(a.grantId, a.grantVersion, { effect: cls.effect, missionId: mission.id, account: cls.account, paths: cls.paths, destinations: cls.destinations, spendUsd: cls.spendUsd })) {
			return "the rule that allowed this was revoked, expired or used up";
		}
		if (a.kind === "approval") {
			const ap = approvals.get(a.approvalId);
			if (!ap || ap.status !== "approved" || ap.intentHash !== intent.argsHash) return "the approval no longer matches this action";
		}
		return undefined;
	}

	async function dispatch(intentId, spec, cls, args, ctx) {
		let intent = ledger.get(intentId);
		const mission = missions.get(intent.missionId);
		const reservation = budgets.reserve(intent.missionId, { toolCalls: 1 });
		if (!reservation.ok) {
			deny(intent, `the mission's ${reservation.limit} budget is used up`, "budget");
			hooks.waiting?.(intent.missionId, "resource", { reason: `budget:${reservation.limit}` });
			throw new BrokerDenied(`Midnight did not run this: the mission reached its ${reservation.limit} budget. Stop and summarize what is done.`, "budget");
		}
		let release = () => {};
		let lease;
		try {
			try {
				release = await locks.acquire(cls.resources ?? [], intent.missionId, { signal: ctx.signal, timeoutMs: cls.lockTimeoutMs ?? 30000 });
				if (cls.screen) lease = await platform.lease.acquire(intent.missionId, { signal: ctx.signal });
			} catch (err) {
				deny(intent, err.message, err.code === "CONFLICT" ? "conflict" : "lease");
				throw new BrokerDenied(`Midnight did not run this: ${err.message}.`, "conflict");
			}
			const why = recheckReason(intent, cls, mission);
			if (why) {
				deny(intent, why, "recheck");
				throw new BrokerDenied(`Midnight did not run this: ${why}.`, "recheck");
			}
			if (mission.dryRun && MUTATING(cls.effect)) {
				// Rehearsal: the full authorization path ran, the effect does not.
				commit(() => {
					ledger.transition(intent.id, "cancelled");
					ledger.receipt(intent.id, { state: "rehearsed", observed: { rehearsal: true } });
					emit("action.reconciled", { missionId: intent.missionId, correlationId: intent.id, payload: { intentId: intent.id, state: "rehearsed", tool: intent.tool, effect: intent.effect } });
				});
				return { content: [{ type: "text", text: `[rehearsal] ${intent.display.title ?? spec.label} would happen here; nothing was changed.` }], details: { rehearsal: true } };
			}
			intent = commit(() => {
				const i = ledger.transition(intent.id, "dispatching");
				if (i.authority?.kind === "grant") grants.use(i.authority.grantId);
				emit("action.dispatched", { missionId: i.missionId, runId: i.runId, correlationId: i.id, payload: { intentId: i.id, tool: i.tool, effect: i.effect } });
				return i;
			});
			let out;
			try {
				out = await spec.execute(args, { ...ctx, mission, intent, idempotencyKey: intent.idempotencyKey, lease, cls });
			} catch (err) {
				const uncertain = isExternal(cls.effect) && (err?.uncertain === true || UNCERTAIN_CODES.has(err?.code) || /timed? ?out|socket hang up/i.test(String(err?.message)));
				if (uncertain) {
					const rec = spec.reconcile ? await spec.reconcile(intent, args, ctx).catch(() => ({ state: "unknown" })) : { state: "unknown" };
					finish(intent, rec.state === "verified" ? "verified" : rec.state === "failed" ? "failed" : "unknown", { remoteId: rec.remoteId, observed: { error: String(err?.message ?? err), reconciled: rec.state }, verification: rec.refs ?? [] });
					if (rec.state === "verified") return { content: [{ type: "text", text: `The service did not answer in time, but Midnight confirmed it happened (${rec.remoteId ?? "receipt recorded"}).` }], details: { receipt: "verified" } };
					if (rec.state !== "failed") {
						hooks.reconcileNeeded?.(intent.missionId, ledger.get(intent.id));
						throw new BrokerDenied("The request may have completed; Midnight is checking before trying again. Do not retry it. Tell the user it needs a check.", "unknown");
					}
				} else finish(intent, "failed", { observed: { error: String(err?.message ?? err).slice(0, 500) } });
				throw err;
			}
			commit(() => ledger.transition(intent.id, "acknowledged"));
			let verdict;
			try {
				verdict = spec.verify ? await spec.verify(args, out, { ...ctx, mission, intent }) : { state: "verified", refs: out.verification ?? [] };
			} catch (err) {
				verdict = { state: "unknown", refs: [String(err?.message ?? err)] };
			}
			finish(intent, verdict.state, {
				remoteId: out.remoteId,
				resultHash: out.resultHash ?? sha256(stableStringify(out.content ?? [])),
				observed: out.observed ?? {},
				verification: verdict.refs ?? [],
			});
			if (verdict.state === "unknown") hooks.reconcileNeeded?.(intent.missionId, ledger.get(intent.id));
			budgets.settle(reservation.reservation, { toolCalls: 1, costUsd: out.costUsd });
			if (verdict.state === "failed") {
				return { ...out, content: [...(out.content ?? []), { type: "text", text: `\n[Midnight could not verify this worked: ${(verdict.refs ?? []).join("; ") || "check failed"}]` }] };
			}
			return out;
		} finally {
			release();
			lease?.release?.();
		}
	}

	function finish(intent, state, receipt) {
		commit(() => {
			const cur = ledger.get(intent.id);
			if (cur.state === "dispatching" && state === "verified") ledger.transition(intent.id, "acknowledged");
			if (ledger.get(intent.id).state !== state) ledger.transition(intent.id, state);
			const r = ledger.receipt(intent.id, { state, ...receipt });
			emit("action.reconciled", { missionId: intent.missionId, runId: intent.runId, correlationId: intent.id, payload: { intentId: intent.id, tool: intent.tool, effect: intent.effect, state, receiptId: r.id, remoteId: receipt.remoteId } });
		});
	}

	function routineDraft(spec, cls, mission) {
		return {
			label: `${spec.label}${cls.destinations?.length ? ` to ${cls.destinations.join(", ")}` : ""}${cls.account ? ` from ${cls.account}` : ""}`.slice(0, 120),
			actionClasses: [cls.effect],
			account: cls.account,
			destinations: cls.destinations ?? [],
			roots: cls.effect.startsWith("local.") ? (cls.paths ?? []) : [],
			limits: { maxActions: 100 },
			expiresInDays: 30,
		};
	}

	return {
		gate,
		/** Run an authorized call of a Midnight tool. Calls that skipped the gate are gated here first. */
		async execute({ missionId, runId, toolCallId, toolName, input, signal, onUpdate }) {
			let p = pending.get(toolCallId);
			if (!p) {
				const g = await gate({ missionId, runId, toolCallId, toolName, input, signal });
				if (g?.block) throw new BrokerDenied(g.reason);
				p = pending.get(toolCallId);
			}
			pending.delete(toolCallId);
			return dispatch(p.intentId, p.spec, p.cls, input ?? p.args, { signal, onUpdate, missionId, runId, toolCallId });
		},
		/** Record the outcome of a foreign tool (no Midnight execute wrapper) from the runtime's tool_result. */
		foreignResult({ toolCallId, isError, content }) {
			const p = pending.get(toolCallId);
			if (!p || !p.spec.foreign) return;
			pending.delete(toolCallId);
			const intent = ledger.get(p.intentId);
			if (isError) finish(intent, "failed", { observed: { error: stableStringify(content).slice(0, 500) } });
			else {
				commit(() => {
					ledger.transition(intent.id, "acknowledged");
					const r = ledger.receipt(intent.id, { state: "acknowledged", resultHash: sha256(stableStringify(content ?? [])), observed: { note: "acknowledged by the tool; not independently verified" } });
					emit("action.reconciled", { missionId: intent.missionId, correlationId: intent.id, payload: { intentId: intent.id, tool: intent.tool, state: "acknowledged", receiptId: r.id } });
				});
			}
		},
		/** Dispatch a stored, approved intent outside a model turn (e.g. approved after a restart). */
		async dispatchStored(intentId, { signal } = {}) {
			const intent = ledger.get(intentId);
			const spec = tools.get(intent.tool);
			if (!spec) throw new Error(`tool ${intent.tool} is not available`);
			const { args } = JSON.parse(journal.getPayload(intent.argsRef) ?? "{}");
			const cls = await spec.classify(args ?? {}, { mission: missions.get(intent.missionId), roots });
			if (intentHash(spec.name, cls.canonical ?? args) !== intent.argsHash) throw new Error("the stored action no longer matches what was approved");
			return dispatch(intentId, spec, cls, args, { signal, missionId: intent.missionId, runId: intent.runId });
		},
		/** Ask the tool whether an uncertain effect happened (startup recovery, user "check again"). */
		async reconcile(intentId) {
			const intent = ledger.get(intentId);
			const spec = tools.get(intent.tool);
			let rec = { state: "unknown" };
			if (spec?.reconcile) {
				const { args } = JSON.parse(journal.getPayload(intent.argsRef) ?? "{}");
				rec = await spec.reconcile(intent, args ?? {}, { missionId: intent.missionId }).catch(() => ({ state: "unknown" }));
			}
			if (rec.state !== intent.state || rec.state !== "unknown") finish(intent, rec.state, { remoteId: rec.remoteId, observed: { reconciled: true, ...(rec.observed ?? {}) }, verification: rec.refs ?? [] });
			return ledger.get(intentId);
		},
		/** The user's explicit decision about an unknown outcome. */
		resolveUnknown(intentId, outcome) {
			const intent = ledger.get(intentId);
			if (intent.state !== "unknown") return intent;
			finish(intent, outcome === "happened" ? "verified" : "failed", { observed: { resolvedBy: "user", outcome } });
			return ledger.get(intentId);
		},
		pendingCount: () => pending.size,
		forget(toolCallId) {
			pending.delete(toolCallId);
		},
	};
}
