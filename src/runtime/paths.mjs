// Where Midnight keeps things. Credentials stay in the midnight.server agent folder (shared with its CLI), passed to
// Pi explicitly so the upstream packages never fall back to ~/.pi (docs/adr/0002-dependencies.md).
import os from "node:os";
import path from "node:path";

export function coreAgentDir() {
	return process.env.MIDNIGHT_CORE_DIR ? path.resolve(process.env.MIDNIGHT_CORE_DIR) : path.join(os.homedir(), ".midnight.server", "agent");
}

export const corePaths = (dir = coreAgentDir()) => ({
	agentDir: dir,
	authPath: path.join(dir, "auth.json"),
	modelsStorePath: path.join(dir, "models-store.json"),
	modelsPath: path.join(dir, "models.json"),
});

/** Layout inside the app's data folder (Electron userData, or a temp folder in tests). */
export const dataPaths = (dataDir) => ({
	dataDir,
	sessions: path.join(dataDir, "sessions"),
	workspaces: path.join(dataDir, "workspaces"),
	backups: path.join(dataDir, "backups"),
	logs: path.join(dataDir, "logs"),
	exports: path.join(dataDir, "exports"),
});
