// Plans and outcome checks (plan ch. 05, R06). The model may propose phases and checks; the coordinator stores
// them as a plan revision before execution, and only Midnight's deterministic evaluation of those checks moves a
// mission to succeeded. Generation ending is never evidence of success.
import { CHECK_KINDS } from "../contracts/domain.mjs";

const TAGS = new Set(["browser", "computer", "approval", "files", "connector", "research"]);
export const MAX_PHASES = 6;

/** Validate and normalize a proposed plan. Throws with a message the model can act on. */
export function normalizePlan(input = {}) {
	const phases = Array.isArray(input.steps) ? input.steps : Array.isArray(input.phases) ? input.phases : [];
	if (!phases.length) throw new Error("a plan needs at least one step");
	if (phases.length > 8) throw new Error(`plans show at most ${MAX_PHASES} steps; merge related steps (got ${phases.length})`);
	const list = phases.length > MAX_PHASES ? [...phases.slice(0, MAX_PHASES - 1), { title: phases.slice(MAX_PHASES - 1).map((p) => p.title).join(" · "), detail: "combined" }] : phases;
	const nodes = list.map((p, i) => ({
		id: `n${i + 1}`,
		title: String(p.title ?? `Step ${i + 1}`).slice(0, 120),
		detail: p.detail ? String(p.detail).slice(0, 300) : "",
		tag: TAGS.has(p.tag) ? p.tag : undefined,
		dependsOn: i ? [`n${i}`] : [],
	}));
	const checks = [];
	const add = (c, phase) => {
		const kind = String(c?.kind ?? "");
		if (!CHECK_KINDS[kind]) throw new Error(`unknown check kind "${kind}"; use one of ${Object.keys(CHECK_KINDS).join(", ")}`);
		checks.push({ id: `c${checks.length + 1}`, kind, label: String(c.label ?? CHECK_KINDS[kind]).slice(0, 160), params: sanitizeParams(c), phase, required: c.required !== false });
	};
	for (const c of input.checks ?? []) add(c, undefined);
	list.forEach((p, i) => {
		for (const c of p.checks ?? []) add(c, `n${i + 1}`);
	});
	if (!checks.some((c) => c.kind === "answer")) checks.push({ id: `c${checks.length + 1}`, kind: "answer", label: CHECK_KINDS.answer, params: {}, required: true });
	return {
		summary: String(input.summary ?? "").slice(0, 200),
		nodes,
		checks,
		usesComputer: !!input.usesComputer,
	};
}

const sanitizeParams = (c) => {
	const out = {};
	for (const k of ["type", "effect", "name", "path"]) if (typeof c[k] === "string") out[k] = c[k].slice(0, 200);
	return out;
};

/** The implicit plan for a question answered without a plan tool call. */
export function implicitPlan() {
	return { summary: "", nodes: [], checks: [{ id: "c1", kind: "answer", label: CHECK_KINDS.answer, params: {}, required: true }], usesComputer: false };
}

export const normalizeUrl = (u) => {
	try {
		const x = new URL(u);
		x.hash = "";
		const host = x.host.replace(/^www\./, "").toLowerCase();
		return `${host}${x.pathname.replace(/\/+$/, "")}${x.search}`;
	} catch {
		return String(u).trim();
	}
};

/** URLs cited in an answer: markdown links and bare URLs. */
export function citedUrls(text) {
	const out = new Set();
	for (const m of String(text ?? "").matchAll(/\]\((https?:\/\/[^\s)]+)\)/g)) out.add(m[1]);
	for (const m of String(text ?? "").matchAll(/(?:^|[\s(])(https?:\/\/[^\s<>)\]]+)/g)) out.add(m[1].replace(/[.,;:]+$/, ""));
	return [...out];
}

/**
 * Evaluate checks against recorded facts.
 * facts: { answer, retrievedUrls: Set<string normalized>, artifacts: [], receipts: [{effect,state}], evidence: number,
 *          calculations: number, confirmations: Map<checkId, boolean> }
 */
export function evaluateChecks(checks, facts) {
	return checks.map((c) => ({ ...c, ...evaluate(c, facts) }));
}

function evaluate(c, f) {
	switch (c.kind) {
		case "answer":
			return f.answer?.trim() ? pass("answer delivered") : fail("no answer was delivered");
		case "citations": {
			const cited = citedUrls(f.answer);
			if (!cited.length) return pass("no web sources cited");
			const missing = cited.filter((u) => !f.retrievedUrls?.has(normalizeUrl(u)));
			return missing.length ? fail(`${missing.length} cited source${missing.length > 1 ? "s were" : " was"} never read: ${missing.slice(0, 3).join(", ")}`) : pass(`${cited.length} source${cited.length > 1 ? "s" : ""} read`);
		}
		case "artifact": {
			const list = (f.artifacts ?? []).filter((a) => !c.params.type || a.type === c.params.type);
			if (list.some((a) => a.validation?.ok)) return pass(`${list.filter((a) => a.validation?.ok).length} validated`);
			return list.length ? fail(`artifact did not validate: ${(list[0].validation?.issues ?? []).join("; ")}`) : fail("no artifact was produced");
		}
		case "receipt": {
			const list = (f.receipts ?? []).filter((r) => !c.params.effect || r.effect === c.params.effect);
			if (list.some((r) => r.state === "verified")) return pass("verified receipt");
			if (list.some((r) => r.state === "unknown")) return { state: "unknown", detail: "outcome unknown; reconciliation needed" };
			if (list.some((r) => r.state === "acknowledged")) return fail("acknowledged but not verified");
			if (list.some((r) => r.state === "rehearsed")) return fail("rehearsed only");
			return fail(list.length ? `not done (${list.at(-1).state})` : "the action did not happen");
		}
		case "file":
			return (f.artifacts ?? []).some((a) => a.publishedPath && (!c.params.path || a.publishedPath.toLowerCase().endsWith(c.params.path.toLowerCase())))
				? pass("published")
				: fail("no file was published");
		case "evidence":
			return f.evidence > 0 ? pass(`${f.evidence} evidence record${f.evidence > 1 ? "s" : ""}`) : fail("no evidence recorded");
		case "calculation":
			return f.calculations > 0 ? pass("deterministic calculation recorded") : fail("numbers were not calculated deterministically");
		case "confirm": {
			const v = f.confirmations?.get(c.id);
			return v === true ? pass("you confirmed") : v === false ? fail("you said this is not right") : { state: "waiting", detail: "waiting for your confirmation" };
		}
		default:
			return fail(`unknown check ${c.kind}`);
	}
}
const pass = (detail) => ({ state: "passed", detail });
const fail = (detail) => ({ state: "failed", detail });

/** Mission outcome from check results. */
export function outcomeOf(results) {
	const req = results.filter((r) => r.required !== false);
	if (req.some((r) => r.state === "unknown")) return "needs-reconciliation";
	if (req.some((r) => r.state === "waiting")) return "waiting-input";
	const passed = req.filter((r) => r.state === "passed").length;
	if (passed === req.length) return "succeeded";
	const answer = req.find((r) => r.kind === "answer");
	if (passed > 0 && answer?.state === "passed") return "partially-succeeded";
	return "failed";
}
