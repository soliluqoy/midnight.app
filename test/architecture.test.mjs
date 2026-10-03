// Boundaries the plan depends on (ch. 03, 04): contracts at the bottom; Pi types private to the adapter; the agent
// host runnable without Electron; the renderer reaching the shell only through the versioned contract; and one
// consistent, recorded source for every Pi package.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { METHODS } from "../src/contracts/ipc.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const src = path.join(root, "src");
const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : /\.(mjs|js|cjs)$/.test(e.name) ? [path.join(dir, e.name)] : []));
const imports = (f) => [...fs.readFileSync(f, "utf8").matchAll(/(?:^|\n)\s*import\s[^;]*?from\s+"([^"]+)"|import\("([^"]+)"\)/g)].map((m) => m[1] ?? m[2]);
const rel = (f) => path.relative(src, f).replace(/\\/g, "/");
const ENGINE = ["contracts", "storage", "policy", "missions", "scheduler", "memory", "evidence", "skills", "resources", "connectors", "windows", "runtime", "tools/documents"];
const all = files(src);

test("contracts depend on nothing else in Midnight", () => {
	for (const f of all.filter((x) => rel(x).startsWith("contracts/"))) {
		for (const i of imports(f)) assert.ok(i.startsWith("node:") || i === "typebox" || i.startsWith("typebox/") || i.startsWith("./"), `${rel(f)} imports ${i}`);
	}
});

test("only the runtime adapter (and its process entry) touches Pi APIs", () => {
	const allowed = new Set(["runtime/adapter.mjs"]);
	for (const f of all) for (const i of imports(f)) if (i.startsWith("@earendil-works/")) assert.ok(allowed.has(rel(f)), `${rel(f)} imports ${i}`);
});

test("the agent host and its modules never import Electron", () => {
	for (const f of all.filter((x) => ENGINE.some((d) => rel(x).startsWith(`${d}/`)))) {
		for (const i of imports(f)) assert.notEqual(i, "electron", `${rel(f)} imports electron`);
	}
	// shell-executed tools are reached through the platform table, never imported by host code
	for (const f of all.filter((x) => rel(x).startsWith("runtime/") || rel(x).startsWith("missions/") || rel(x).startsWith("policy/"))) {
		for (const i of imports(f)) assert.ok(!/tools\/(web|browser|computer|userbrowser)\.mjs$/.test(i), `${rel(f)} imports a shell tool ${i}`);
	}
});

test("the renderer has no module imports and no Node access", () => {
	for (const f of fs.readdirSync(path.join(src, "ui")).filter((x) => x.endsWith(".js"))) {
		const s = fs.readFileSync(path.join(src, "ui", f), "utf8");
		assert.doesNotMatch(s, /\brequire\(|^import /m, `ui/${f}`);
	}
	const main = fs.readFileSync(path.join(src, "main.mjs"), "utf8");
	assert.match(main, /contextIsolation: true, sandbox: true, nodeIntegration: false/);
	assert.match(main, /will-navigate", \(e\) => e\.preventDefault\(\)/);
});

test("preload, contract and host expose exactly the same methods; nothing generic", () => {
	const pre = fs.readFileSync(path.join(src, "preload.cjs"), "utf8");
	const used = new Set([...pre.matchAll(/(?:call|m)\("([a-z]+\.[A-Za-z]+)"/g)].map((x) => x[1]));
	assert.deepEqual([...used].sort(), Object.keys(METHODS).sort());
	assert.doesNotMatch(pre, /exposeInMainWorld\([^)]*invoke\s*:/);
	const host = fs.readFileSync(path.join(src, "runtime", "host.mjs"), "utf8");
	const impl = new Set([...host.matchAll(/\t\t"([a-z]+\.[A-Za-z]+)": /g)].map((x) => x[1]));
	for (const [k, v] of Object.entries(METHODS)) if (v.route === "host") assert.ok(impl.has(k), `host does not implement ${k}`);
});

test("every Pi package comes from the one source recorded in vendor/PROVENANCE.json", () => {
	const prov = JSON.parse(fs.readFileSync(path.join(root, "vendor", "PROVENANCE.json"), "utf8"));
	const versions = new Set(prov.packages.map((p) => p.version));
	assert.equal(versions.size, 1, "one core version");
	const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
	for (const [k, v] of Object.entries(lock.packages)) {
		if (!k.startsWith("node_modules/@earendil-works/")) continue;
		const name = k.slice("node_modules/".length);
		const rec = prov.packages.find((p) => p.name === name);
		assert.ok(rec, `${name} is installed but not in PROVENANCE.json`);
		assert.equal(v.version, rec.version, `${name} version`);
		assert.equal(v.resolved, `file:vendor/${rec.file}`, `${name} must come from the vendored tarball`);
		assert.equal(v.integrity, rec.integrity, `${name} integrity`);
	}
});
