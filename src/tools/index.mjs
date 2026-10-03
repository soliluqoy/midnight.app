// Assembles every tool and host service in one place, so the host stays readable and tests can build the same set.
import { createConnectorRegistry } from "../connectors/registry.mjs";
import { demoCrm, demoMail } from "../connectors/demo.mjs";
import { createMemory } from "../memory/store.mjs";
import { createVault } from "../policy/vault.mjs";
import { createResources } from "../resources/profiles.mjs";
import { createAttention } from "../scheduler/attention.mjs";
import { createWatches } from "../scheduler/watches.mjs";
import { createRecipes, createSkills } from "../skills/registry.mjs";
import { createData } from "../storage/data.mjs";
import { connectorTools } from "./connector-tools.mjs";
import { fileTools } from "./files.mjs";
import { missionTools } from "./mission-tools.mjs";
import { shellTools } from "./shell-tools.mjs";
import { workTools } from "./work.mjs";

// Tools every mission gets; shell tools are left out for offline missions (the broker would block them anyway).
const MISSION = ["plan", "step", "ask_user", "remember"];
const LOCAL = ["files_find", "files_read", "file_publish", "files_move", "files_undo_moves", "sheet_read", "calculate", "chart_create", "report_create", "crm_query", "mail_draft", "mail_send", "open_draft"];
const WEB = ["search", "read_pages", "browser", "user_browser"];

export function buildTools(s) {
	const connectors = createConnectorRegistry();
	if (s.settings().demoConnectors) {
		connectors.register(demoCrm());
		connectors.register(demoMail());
	}
	const memory = createMemory(s.store, s.emit, s.commit);
	const attention = createAttention({ store: s.store, commit: s.commit, emit: s.emit, settings: s.settings });
	const coordProxy = {
		createMission: (...a) => s.coord().createMission(...a),
		suggestMemory: (...a) => s.coord().suggestMemory(...a),
		proposePlan: (...a) => s.coord().proposePlan(...a),
		markStep: (...a) => s.coord().markStep(...a),
		askUser: (...a) => s.coord().askUser(...a),
	};
	const shell = shellTools({ platform: s.platform, evidence: s.evidence, commit: s.commit });
	const groups = [missionTools(coordProxy), fileTools(s).all, workTools(s).all, connectorTools({ connectors, evidence: s.evidence, commit: s.commit, platform: s.platform }).all, shell.all];
	const all = groups.flat();
	const names = new Set(all.map((t) => t.name));
	const skills = createSkills({ toolNames: names });
	const watches = createWatches({ ...s, connectors, attention, stop: { proactivePaused: () => false, ...s.stop }, coord: s.coord });
	const recipes = createRecipes({ store: s.store, repo: s.repo, ledger: s.ledger, evidence: s.evidence, coord: s.coord });
	const data = createData({ store: s.store, journal: s.journal, commit: s.commit, paths: s.paths, memory, version: s.version ?? "midnight" });
	const vault = createVault({ store: s.store, platform: s.platform });
	return {
		all,
		connectors,
		memory,
		attention,
		skills,
		watches,
		recipes,
		data,
		vault,
		resources: undefined, // set by the host once the queue exists
		/** Tool names offered to a mission's model. */
		forMission(mission, settings) {
			const out = [...MISSION, ...LOCAL];
			if (mission.privacy !== "offline") out.push(...WEB);
			if (settings.computerUse !== "never" && mission.privacy !== "offline") out.push("computer");
			return out;
		},
	};
}

export { createResources };
