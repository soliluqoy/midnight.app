// SQLite storage with a single owner (plan ch. 18). One process holds midnight.db at a time: a lock file names
// the owner's pid, and a stale lock (dead pid) is taken over. WAL lets readers and the one writer coexist; we
// use synchronous=FULL so a committed intent survives power loss, not only a process kill (docs/storage.md).
import fs from "node:fs";
import path from "node:path";
import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";
import { LATEST_SCHEMA, MIGRATIONS } from "./migrations.mjs";

export class StorageLockedError extends Error {}
export class NewerSchemaError extends Error {}

const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err.code === "EPERM";
	}
};

function acquireLock(file) {
	for (let i = 0; i < 2; i++) {
		try {
			const fd = fs.openSync(file, "wx");
			fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
			fs.closeSync(fd);
			return () => {
				try {
					const owner = JSON.parse(fs.readFileSync(file, "utf8"));
					if (owner.pid === process.pid) fs.rmSync(file, { force: true });
				} catch {}
			};
		} catch (err) {
			if (err.code !== "EEXIST") throw err;
			let owner = {};
			try {
				owner = JSON.parse(fs.readFileSync(file, "utf8"));
			} catch {}
			if (owner.pid && alive(owner.pid)) {
				throw new StorageLockedError(`midnight data is open in another process (pid ${owner.pid})`);
			}
			fs.rmSync(file, { force: true }); // stale owner: take over
		}
	}
	throw new StorageLockedError("could not acquire the storage lock");
}

/**
 * Open (and migrate) the database in `dir`.
 * @param {string} dir data directory
 * @param {{ backupsDir?: string, readOnlyIfNewer?: boolean, lock?: boolean, file?: string }} options
 */
export async function openStore(dir, { backupsDir, readOnlyIfNewer = true, lock = true, file = "midnight.db" } = {}) {
	fs.mkdirSync(dir, { recursive: true });
	const dbPath = path.join(dir, file);
	const release = lock ? acquireLock(`${dbPath}.lock`) : () => {};
	let db;
	try {
		db = new DatabaseSync(dbPath);
		db.exec("PRAGMA busy_timeout = 5000");
		const version = db.prepare("PRAGMA user_version").get().user_version;
		let readOnly = false;
		if (version > LATEST_SCHEMA) {
			if (!readOnlyIfNewer) throw new NewerSchemaError(`data schema ${version} is newer than this build (${LATEST_SCHEMA})`);
			db.close();
			db = new DatabaseSync(dbPath, { readOnly: true });
			readOnly = true;
		} else {
			db.exec("PRAGMA journal_mode = WAL");
			db.exec("PRAGMA synchronous = FULL");
			db.exec("PRAGMA foreign_keys = ON");
			if (version < LATEST_SCHEMA) {
				if (version > 0) await backupTo(db, path.join(backupsDir ?? path.join(dir, "backups"), `midnight-v${version}-${stamp()}.db`));
				migrate(db, version);
			}
		}
		return wrap(db, { dir, dbPath, readOnly, release, schema: readOnly ? version : LATEST_SCHEMA });
	} catch (err) {
		try {
			db?.close();
		} catch {}
		release();
		throw err;
	}
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

function migrate(db, from) {
	for (const m of MIGRATIONS) {
		if (m.version <= from) continue;
		db.exec("BEGIN IMMEDIATE");
		try {
			db.exec(m.sql);
			db.exec(`PRAGMA user_version = ${m.version}`);
			db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(`migration.${m.version}`, JSON.stringify({ name: m.name, at: new Date().toISOString() }));
			db.exec("COMMIT");
		} catch (err) {
			db.exec("ROLLBACK");
			throw new Error(`migration ${m.version} (${m.name}) failed: ${err.message}`);
		}
	}
}

/** Consistent online backup (includes WAL contents); copying the main file alone would not be. */
export async function backupTo(db, dest) {
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	await sqliteBackup(db, dest);
	return dest;
}

function wrap(db, info) {
	const stmts = new Map();
	const prep = (sql) => {
		let s = stmts.get(sql);
		if (!s) {
			s = db.prepare(sql);
			stmts.set(sql, s);
		}
		return s;
	};
	let depth = 0;
	const store = {
		...info,
		raw: db,
		run: (sql, ...args) => prep(sql).run(...args),
		get: (sql, ...args) => prep(sql).get(...args),
		all: (sql, ...args) => prep(sql).all(...args),
		exec: (sql) => db.exec(sql),
		/** Atomic unit of work; nested calls join the outer transaction. */
		tx(fn) {
			if (info.readOnly) throw new Error("storage is read-only (data from a newer Midnight)");
			if (depth > 0) return fn();
			db.exec("BEGIN IMMEDIATE");
			depth++;
			try {
				const out = fn();
				depth--;
				db.exec("COMMIT");
				return out;
			} catch (err) {
				depth--;
				try {
					db.exec("ROLLBACK");
				} catch {}
				throw err;
			}
		},
		meta(key, value) {
			if (value === undefined) return store.get("SELECT value FROM meta WHERE key = ?", key)?.value;
			store.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", key, String(value));
		},
		backup: (dest) => backupTo(db, dest ?? path.join(info.dir, "backups", `midnight-manual-${stamp()}.db`)),
		close() {
			try {
				if (!info.readOnly) db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
			} catch {}
			db.close();
			info.release();
		},
	};
	return store;
}

/** Replace the live database with a backup. The store must be closed first; the -wal/-shm of the old file go too. */
export function restoreBackup(dir, backupFile, file = "midnight.db") {
	const dbPath = path.join(dir, file);
	for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(f, { force: true });
	fs.copyFileSync(backupFile, dbPath);
	return dbPath;
}

export const json = (v, fallback) => {
	if (v === null || v === undefined || v === "") return fallback;
	try {
		return JSON.parse(v);
	} catch {
		return fallback;
	}
};
