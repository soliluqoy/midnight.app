// Pack the midnight.server core packages into vendor/*.tgz so the app installs and builds anywhere (CI, other OSes)
// without a sibling checkout. Run after building ../midnight.server:  node scripts/vendor-core.mjs [path-to-midnight.server]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const server = path.resolve(process.argv[2] ?? path.join(root, "..", "midnight.server"));
const PACKAGES = { chord: "chord", telemetry: "pi-telemetry", ai: "pi-ai", agent: "pi-agent-core", tui: "pi-tui", "coding-agent": "pi-coding-agent" };
const vendor = path.join(root, "vendor");

fs.rmSync(vendor, { recursive: true, force: true });
fs.mkdirSync(vendor);
const pkgPath = path.join(root, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
pkg.dependencies ??= {};
pkg.overrides = {};

for (const [dir, name] of Object.entries(PACKAGES)) {
	const src = path.join(server, "packages", dir);
	if (!fs.existsSync(path.join(src, "dist"))) throw new Error(`${src} is not built; run npm run build in midnight.server first`);
	const out = execFileSync("npm", ["pack", "--silent", "--pack-destination", vendor], { cwd: src, encoding: "utf8", shell: process.platform === "win32" });
	const file = out.trim().split(/\r?\n/).pop();
	const spec = `file:vendor/${file}`;
	pkg.dependencies[`@earendil-works/${name}`] = spec;
	pkg.overrides[`@earendil-works/${name}`] = `$@earendil-works/${name}`; // transitive ^x.y.z resolve to the same tarball
	console.log(`packed ${name} -> vendor/${file}`);
}

pkg.dependencies = Object.fromEntries(Object.entries(pkg.dependencies).sort(([a], [b]) => a.localeCompare(b)));
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, "\t")}\n`);
console.log("package.json updated; now run npm install");
