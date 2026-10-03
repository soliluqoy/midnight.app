// Connector tools (plan ch. 12, 15; T04/T05). Typed connectors first: CRM reads record their query, account and
// freshness as evidence; a mail send binds the exact recipients, account, body and attachment hashes into the
// intent, uses the provider idempotency key, and is reconciled by that key if the response is lost.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { normalizeAddress } from "../policy/canonical.mjs";
import { readEml, writeEml } from "../connectors/eml.mjs";

const sha = (s) => `sha256:${createHash("sha256").update(s).digest("hex")}`;
const MIME = { ".svg": "image/svg+xml", ".png": "image/png", ".csv": "text/csv", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".pdf": "application/pdf", ".md": "text/markdown" };

export function connectorTools({ connectors, evidence, commit, platform }) {
	const crmQuery = {
		name: "crm_query",
		label: "CRM",
		description: "Query the connected CRM (read only), e.g. object deals with filters {quarter: \"Q3\", stage: \"closed-won\"}. All pages are fetched. Records evidence with the query, account and retrieval time.",
		parameters: Type.Object({
			object: Type.Optional(Type.String({ description: "default deals" })),
			filters: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Number()]))),
			connector: Type.Optional(Type.String()),
		}),
		classify(a) {
			const c = connectors.pick("crm", a.connector);
			if (!c) throw new Error("no CRM is connected; tell the user which numbers you could not check");
			return { effect: "read.connector", account: c.account, target: `${c.label} · ${a.object ?? "deals"}`, network: !c.local, localNetwork: !!c.local, canonical: { connector: c.id, object: a.object ?? "deals", filters: a.filters ?? {} }, feed: `crm › ${a.object ?? "deals"} ${JSON.stringify(a.filters ?? {})}` };
		},
		async execute(a, ctx) {
			const c = connectors.pick("crm", a.connector);
			const records = [];
			let cursor = 0;
			let retrievedAt;
			for (let pages = 0; cursor !== undefined && pages < 50; pages++) {
				const r = await connectors.call(c, "query", { object: a.object ?? "deals", filters: a.filters ?? {}, cursor }, { signal: ctx.signal });
				records.push(...r.records);
				cursor = r.next;
				retrievedAt = r.retrievedAt;
			}
			const hash = sha(JSON.stringify(records));
			const id = commit(() => evidence.record(ctx.missionId, { kind: "connector", source: `${c.id}:${a.object ?? "deals"}`, sourceVersion: c.version, hash, freshness: retrievedAt, locator: { account: c.account, query: { object: a.object ?? "deals", filters: a.filters ?? {} }, count: records.length }, excerpt: JSON.stringify(records.slice(0, 10)) }));
			const cols = [...new Set(records.flatMap((r) => Object.keys(r)))];
			const table = [cols.join(" | "), ...records.slice(0, 200).map((r) => cols.map((k) => r[k] ?? "").join(" | "))].join("\n");
			return { content: [{ type: "text", text: `${c.label} (${c.account}) · ${records.length} records · retrieved ${retrievedAt} · evidence ${id}${c.demo ? " · DEMO DATA" : ""}\n${table}` }], details: { evidenceId: id, count: records.length } };
		},
	};

	const draft = {
		name: "mail_draft",
		label: "Draft email",
		description: "Write an email draft (.eml) with exact recipients and attachments (artifact ids). Nothing is sent. Changing anything later makes a new revision that needs a fresh approval to send.",
		parameters: Type.Object({
			to: Type.Array(Type.String(), { minItems: 1, maxItems: 20 }),
			cc: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
			subject: Type.String({ maxLength: 300 }),
			body: Type.String({ maxLength: 20000 }),
			attachments: Type.Optional(Type.Array(Type.String({ description: "artifact id" }), { maxItems: 10 })),
		}),
		classify: (a) => {
			for (const x of [...a.to, ...(a.cc ?? [])]) if (!/^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(normalizeAddress(x))) throw new Error(`"${x}" is not a complete email address; resolve the recipient before drafting`);
			return { effect: "artifact.stage", target: a.subject, canonical: a, feed: `mail › draft “${a.subject.slice(0, 40)}” to ${a.to.length + (a.cc?.length ?? 0)}` };
		},
		async execute(a, ctx) {
			const atts = (a.attachments ?? []).map((id) => {
				const art = evidence.artifact(id);
				if (!art) throw new Error(`no artifact ${id}`);
				if (!art.validation?.ok) throw new Error(`${art.name} r${art.revision} did not validate; fix it before attaching`);
				return { art, data: fs.readFileSync(art.path) };
			});
			const to = a.to.map(normalizeAddress);
			const cc = (a.cc ?? []).map(normalizeAddress);
			const eml = writeEml({ to, cc, subject: a.subject, body: a.body, attachments: atts.map(({ art, data }) => ({ name: art.name, data, type: MIME[path.extname(art.name).toLowerCase()] })) });
			const back = readEml(eml);
			const issues = [];
			if (back.to.join() !== to.join()) issues.push("recipients changed when written");
			atts.forEach(({ art }, i) => back.attachments[i]?.hash !== art.hash && issues.push(`attachment ${art.name} does not match its hash`));
			const facts = { to, cc, subject: a.subject, bodyHash: sha(a.body), body: a.body.slice(0, 2000), attachments: atts.map(({ art }) => ({ id: art.id, name: art.name, revision: art.revision, hash: art.hash })) };
			const art = commit(() => evidence.stage(ctx.missionId, ctx.runId, { name: `${a.subject.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").toLowerCase().slice(0, 60) || "draft"}.eml`, type: "mail-draft", data: eml, sources: atts.map(({ art }) => art.id), validation: { ok: issues.length === 0, issues, facts } }));
			return { content: [{ type: "text", text: `Draft ${art.name} r${art.revision} (${art.id}) to ${[...to, ...cc].join(", ")}${atts.length ? ` with ${atts.map(({ art: x }) => `${x.name} r${x.revision}`).join(", ")}` : ""}. Not sent.` }], details: { artifactId: art.id } };
		},
	};

	const draftFacts = (id) => {
		const art = evidence.artifact(id);
		if (!art || art.type !== "mail-draft") throw new Error(`${id} is not a mail draft`);
		if (!art.validation?.ok) throw new Error("this draft did not validate");
		const latest = evidence.latest(art.missionId, art.name);
		if (latest && latest.revision !== art.revision) throw new Error(`a newer revision (r${latest.revision}) of this draft exists; send that one`);
		return { art, f: art.validation.facts };
	};

	const send = {
		name: "mail_send",
		label: "Send email",
		description: "Send a validated draft from the connected mail account. Midnight shows the user the exact recipients, account and attachments unless a rule already covers it. If it says the outcome is unknown, do not retry.",
		parameters: Type.Object({ draftId: Type.String(), connector: Type.Optional(Type.String()) }),
		classify(a) {
			const { art, f } = draftFacts(a.draftId);
			const c = connectors.pick("mail", a.connector);
			if (!c) throw new Error(`no mail account is connected. The draft is saved as ${art.name}; offer open_draft so the user can send it from their mail app`);
			const recipients = [...f.to, ...f.cc];
			return {
				effect: "external.communication",
				account: c.account,
				destinations: recipients,
				network: !c.local,
				localNetwork: !!c.local,
				target: recipients.join(", "),
				canonical: { connector: c.id, account: c.account, to: [...f.to].sort(), cc: [...f.cc].sort(), subject: f.subject, bodyHash: f.bodyHash, attachments: f.attachments.map((x) => x.hash), draft: art.hash },
				display: {
					title: `Send “${f.subject}”`,
					verb: "Send now",
					decline: "Keep draft",
					account: `${c.account}${c.demo ? " (demo: nothing is really sent)" : ""}`,
					recipients,
					attachments: f.attachments.map((x) => ({ name: x.name, revision: x.revision, hash: x.hash })),
					preview: f.body,
					consequence: c.demo ? "Demo mail account: the message is recorded, not delivered." : `${recipients.length} recipient${recipients.length > 1 ? "s" : ""} will receive this. It cannot be unsent.`,
				},
				feed: `mail › send “${f.subject.slice(0, 40)}” to ${recipients.length}`,
			};
		},
		async execute(a, ctx) {
			const { art, f } = draftFacts(a.draftId);
			const c = connectors.pick("mail", a.connector);
			const r = await connectors.call(c, "send", { to: f.to, cc: f.cc, subject: f.subject, body: f.body, eml: fs.readFileSync(art.path) }, { signal: ctx.signal, idempotencyKey: ctx.idempotencyKey });
			return { content: [{ type: "text", text: `Sent “${f.subject}” to ${[...f.to, ...f.cc].join(", ")} (message ${r.remoteId}).` }], remoteId: r.remoteId, observed: { account: c.account, to: f.to, cc: f.cc, draft: art.hash } };
		},
		async verify(a, out, ctx) {
			const c = connectors.pick("mail", a.connector);
			if (typeof c.find !== "function") return { state: "verified", refs: [`provider id ${out.remoteId}`] };
			const r = await connectors.call(c, "find", {}, { idempotencyKey: ctx.idempotencyKey ?? ctx.intent?.idempotencyKey });
			return r.found ? { state: "verified", refs: [`provider has ${r.remoteId}`] } : { state: "unknown", refs: ["provider does not show the message yet"] };
		},
		async reconcile(intent, a) {
			const c = connectors.pick("mail", a.connector);
			if (typeof c?.find !== "function") return { state: "unknown" };
			const r = await connectors.call(c, "find", {}, { idempotencyKey: intent.idempotencyKey });
			return r.found ? { state: "verified", remoteId: r.remoteId, refs: ["found by idempotency key"] } : { state: c.idempotent ? "failed" : "unknown", refs: [r.found ? "" : "not found by idempotency key"] };
		},
	};

	const openDraft = {
		name: "open_draft",
		label: "Open draft",
		description: "Open a mail draft in the user's own mail app so they can review and send it themselves.",
		parameters: Type.Object({ draftId: Type.String() }),
		classify: (a) => ({ effect: "open.user", target: a.draftId, canonical: a, feed: "mail › open draft in your mail app", icon: "↗" }),
		async execute(a) {
			const art = evidence.artifact(a.draftId);
			if (!art) throw new Error(`no draft ${a.draftId}`);
			await platform.call("open.path", { path: art.publishedPath ?? art.path });
			return { content: [{ type: "text", text: `Opened ${art.name} in the user's mail app. They send it themselves.` }] };
		},
	};

	return { all: [crmQuery, draft, send, openDraft] };
}
