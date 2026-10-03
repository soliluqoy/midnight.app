// Selected folders (plan ch. 07, 11). Discovery and reading are scoped to folders the user picked in a trusted
// OS dialog; "output" folders are where Prepare-for-me may publish drafts. Paths are canonicalized with realpath
// when added, and re-checked at dispatch by the file tools (junctions and symlinks can change underneath).
import fs from "node:fs";
import path from "node:path";
import { newId } from "../contracts/events.mjs";
import { within } from "./grants.mjs";

/** Real path of `p` (or of its nearest existing parent for a file that does not exist yet). */
export function realTarget(p) {
	let cur = path.resolve(p);
	const tail = [];
	while (!fs.existsSync(cur)) {
		tail.unshift(path.basename(cur));
		const up = path.dirname(cur);
		if (up === cur) break;
		cur = up;
	}
	return path.join(fs.realpathSync.native(cur), ...tail);
}

/**
 * Request paths in the same form as stored roots (realpath, long names), so a short name (C:PROGRA~1) or a link
 * decides authority by where it really points. A path that cannot be resolved is kept as given.
 */
export function resolvePaths(cls) {
	if (!cls?.paths?.length) return cls;
	const real = (p) => {
		try {
			return realTarget(p);
		} catch {
			return p;
		}
	};
	return { ...cls, paths: cls.paths.map(real) };
}

export function createRoots(store) {
	const row = (r) => ({ id: r.id, path: r.path, purpose: r.purpose, label: r.label, createdAt: r.created_at });
	const api = {
		list: () => store.all("SELECT * FROM roots ORDER BY created_at").map(row),
		/** Only the shell's folder picker (a trusted dialog) calls this. */
		add(dir, purpose = "source") {
			const real = fs.realpathSync.native(path.resolve(dir));
			if (!fs.statSync(real).isDirectory()) throw new Error(`${dir} is not a folder`);
			const existing = store.get("SELECT * FROM roots WHERE path = ?", real);
			if (existing) {
				if (existing.purpose !== purpose && purpose === "output") store.run("UPDATE roots SET purpose = 'output' WHERE id = ?", existing.id);
				return row(store.get("SELECT * FROM roots WHERE id = ?", existing.id));
			}
			const id = newId("root");
			store.run("INSERT INTO roots (id, path, purpose, label, created_at) VALUES (?, ?, ?, ?, ?)", id, real, purpose, path.basename(real) || real, new Date().toISOString());
			return row(store.get("SELECT * FROM roots WHERE id = ?", id));
		},
		remove: (id) => store.run("DELETE FROM roots WHERE id = ?", id).changes > 0,
		covers: (root, p) => within(root.path, p),
		/** The root that contains `p`, if any. */
		find: (p) => api.list().find((r) => within(r.path, p)),
	};
	return api;
}
