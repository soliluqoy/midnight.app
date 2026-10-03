// Tools the model uses to shape its mission: record a plan with outcome checks, report step progress, ask the user
// for a decision, and suggest something to remember. They change mission state only through the coordinator and
// pass through the broker like every other tool (effect "compute": internal, no external effect).
import { Type } from "typebox";
import { CHECK_KINDS } from "../contracts/domain.mjs";

const Check = Type.Object({
	kind: Type.Union(Object.keys(CHECK_KINDS).map((k) => Type.Literal(k))),
	label: Type.Optional(Type.String()),
	type: Type.Optional(Type.String({ description: "artifact: chart | report | spreadsheet | mail-draft | file" })),
	effect: Type.Optional(Type.String({ description: "receipt: e.g. external.communication" })),
	path: Type.Optional(Type.String()),
});

const internal = (label) => (a) => ({ effect: "compute", target: label, canonical: a, feed: label });

export function missionTools(coord) {
	return [
		{
			name: "plan",
			label: "Plan",
			description:
				"Record your plan for a task that produces files or acts: 2-6 short steps and the outcome checks that prove it is done. " +
				"It returns at once for plans that only read and prepare; if usesComputer is true the user must approve desktop control first.",
			promptSnippet: "plan: record 2-6 steps and outcome checks before working on a task",
			parameters: Type.Object({
				summary: Type.Optional(Type.String({ description: "One line: what will be done" })),
				steps: Type.Array(
					Type.Object({
						title: Type.String(),
						detail: Type.Optional(Type.String()),
						tag: Type.Optional(Type.Union(["browser", "computer", "approval", "files", "connector", "research"].map((t) => Type.Literal(t)))),
						checks: Type.Optional(Type.Array(Check)),
					}),
					{ minItems: 1, maxItems: 8 },
				),
				checks: Type.Optional(Type.Array(Check, { description: "Mission-level outcome checks" })),
				usesComputer: Type.Optional(Type.Boolean({ description: "true if you need mouse/keyboard on the desktop" })),
				reason: Type.Optional(Type.String({ description: "When revising a plan: what changed" })),
			}),
			executionMode: "sequential",
			classify: (a) => ({ effect: "compute", target: a.summary ?? "", canonical: a, feed: `plan · ${a.steps?.length ?? 0} steps${a.usesComputer ? " · uses your screen" : ""}` }),
			execute: (a, ctx) => coord.proposePlan(ctx.missionId, a, ctx.signal),
		},
		{
			name: "step",
			label: "Step",
			description: "Mark a plan step active, done or skipped (0-based index), with an optional short note. Done is your report; Midnight still verifies the outcome.",
			parameters: Type.Object({
				step: Type.Integer({ minimum: 0 }),
				status: Type.Union([Type.Literal("active"), Type.Literal("done"), Type.Literal("skipped")]),
				note: Type.Optional(Type.String()),
			}),
			classify: (a) => ({ effect: "compute", target: `step ${a.step}`, canonical: a, feed: `step ${a.step + 1} · ${a.status}${a.note ? ` — ${a.note}` : ""}` }),
			execute: (a, ctx) => coord.markStep(ctx.missionId, a),
		},
		{
			name: "ask_user",
			label: "Ask the user",
			description:
				"Ask the user for a decision only they can make (which of two files is final, which recipient). Give 2-6 short options when possible. Blocks until they answer.",
			parameters: Type.Object({
				question: Type.String(),
				options: Type.Optional(Type.Array(Type.String(), { maxItems: 6 })),
			}),
			executionMode: "sequential",
			classify: internal("asks you a question"),
			execute: (a, ctx) => coord.askUser(ctx.missionId, a.question, a.options ?? [], ctx.signal),
		},
		{
			name: "remember",
			label: "Remember",
			description:
				"Suggest something to remember across missions (a stated preference such as where reports go). It is saved as a suggestion the user confirms in Settings → Memory; it never grants permission.",
			parameters: Type.Object({ text: Type.String({ maxLength: 400 }), kind: Type.Optional(Type.Union([Type.Literal("preference"), Type.Literal("fact")])) }),
			classify: internal("suggests something to remember"),
			execute: (a, ctx) => coord.suggestMemory(ctx.missionId, a.text, a.kind ?? "preference"),
		},
	];
}
