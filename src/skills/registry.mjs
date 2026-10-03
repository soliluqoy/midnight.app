// Skill packs and recipes (plan ch. 12, K02). A skill is a reviewed, versioned workflow manifest: purpose, inputs,
// outputs, capabilities, tools, network destinations and checks. Loading a skill adds guidance; it never grants
// permission or runs install scripts. A recipe captured from a verified mission is a parameterized template the user
// reviews; every run still rechecks files, accounts, grants and schemas through the broker.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHECK_KINDS, EFFECTS } from "../contracts/domain.mjs";
import { newId } from "../contracts/events.mjs";
import { json } from "../storage/db.mjs";

const PACKS = fileURLToPath(new URL("./packs/", import.meta.url));
const FIELDS = ["id", "version", "title", "purpose", "capabilities", "tools", "prompt"];

export function validateSkill(m, toolNames) {
	const issues = [];
	for (const f of FIELDS) if (m[f] === undefined) issues.push(`missing ${f}`);
	if (!/^[a-z0-9-]+$/.test(m.id ?? "")) issues.push("id must be lowercase letters, digits and dashes");
	for (const c of m.capabilities ?? []) if (!EFFECTS[c]) issues.push(`unknown capability ${c}`);
	for (const t of m.tools ?? []) if (toolNames && !toolNames.has(t)) issues.push(`unknown tool ${t}`);
	for (const c of m.checks ?? []) if (!CHECK_KINDS[c.kind]) issues.push(`unknown check ${c.kind}`);
	for (const k of ["grants", "install", "postinstall", "scripts", "exec"]) if (k in m) issues.push(`${k} is not allowed in a skill`);
	return issues;
}

export function createSkills({ toolNames, dir = PACKS }) {
	const skills = new Map();
	const rejected = [];
	for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
		if (!f.endsWith(".json")) continue;
		try {
			const m = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
			const issues = validateSkill(m, toolNames);
			if (issues.length) rejected.push({ file: f, issues });
			else skills.set(m.id, Object.freeze({ ...m, file: f }));
		} catch (err) {
			rejected.push({ file: f, issues: [err.message] });
		}
	}
	return {
		get: (id) => skills.get(id),
		list: () => [...skills.values()].map(({ prompt, ...rest }) => rest),
		rejected: () => rejected,
		/** Best skill for a request by simple keyword match (a hint the user can override). */
		suggest(text) {
			const t = text.toLowerCase();
			if (/\b(sales|revenue|quarter|q[1-4])\b/.test(t) && /\b(brief|chart|report|compare)\b/.test(t)) return "sales-brief";
			if (/\b(tidy|organi[sz]e|clean up)\b/.test(t) && /\b(folder|downloads|files)\b/.test(t)) return "file-organizer";
			if (/\b(meeting|agenda)\b/.test(t) && /\b(brief|pack|prep)/.test(t)) return "meeting-prep";
			return undefined;
		},
	};
}

export function createRecipes({ store, repo, ledger, evidence, coord }) {
	const row = (r) => r && { id: r.id, label: r.label, version: r.version, sourceMission: r.source_mission, template: json(r.template, {}), reviewed: !!r.reviewed, createdAt: r.created_at };
	return {
		/** Capture a verified mission as a reviewable recipe (never coordinates or raw clicks). */
		capture(missionId, label) {
			const m = repo.get(missionId);
			if (!m) throw new Error("no such mission");
			if (m.status !== "succeeded") return { ok: false, error: "Only a mission whose checks all passed can become a recipe." };
			const plan = repo.plan(missionId);
			const intents = ledger.forMission(missionId);
			if (intents.some((i) => i.effect.startsWith("desktop."))) return { ok: false, error: "Missions that used the screen cannot become recipes; screen steps are not reliably repeatable." };
			const template = {
				goal: m.goal,
				skill: m.skill,
				mode: m.mode,
				privacy: m.privacy,
				checks: plan?.checks ?? [],
				tools: [...new Set(intents.filter((i) => i.state === "verified").map((i) => i.tool))],
				effects: [...new Set(intents.filter((i) => i.state === "verified").map((i) => i.effect))],
				artifacts: evidence.artifacts(missionId).map((a) => ({ name: a.name, type: a.type })),
			};
			const id = newId("rcp");
			store.run("INSERT INTO recipes (id, label, source_mission, template, created_at) VALUES (?, ?, ?, ?, ?)", id, label.slice(0, 120), missionId, JSON.stringify(template), new Date().toISOString());
			return { ok: true, recipe: row(store.get("SELECT * FROM recipes WHERE id = ?", id)), review: "Review the steps and effects before scheduling it; it will still ask before anything not covered by a rule." };
		},
		list: () => store.all("SELECT * FROM recipes ORDER BY created_at DESC").map(row),
		get: (id) => row(store.get("SELECT * FROM recipes WHERE id = ?", id)),
		markReviewed: (id) => store.run("UPDATE recipes SET reviewed = 1 WHERE id = ?", id).changes > 0,
		run(id, { requestId }) {
			const r = row(store.get("SELECT * FROM recipes WHERE id = ?", id));
			if (!r?.reviewed) throw new Error("review this recipe before running it");
			return coord().createMission({ text: r.template.goal, requestId, skill: r.template.skill, mode: r.template.mode, privacy: r.template.privacy, trigger: { kind: "routine", recipeId: id }, title: r.label });
		},
	};
}
