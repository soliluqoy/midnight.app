// Pack the Pi-family core packages into vendor/*.tgz so the app installs and builds anywhere (CI, other OSes)
// without a sibling checkout or registry drift. Every package comes from ONE source, never a mix:
//   node scripts/vendor-core.mjs [path-to-midnight.server]   fork build (run after building ../midnight.server)
//   node scripts/vendor-core.mjs --upstream 1.0.1            published upstream release, integrity-checked
// Writes vendor/PROVENANCE.json; test/provenance.test.mjs checks the install against it.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
// fork package directory -> package name
export const PACKAGES = {
	chord: "chord",
	telemetry: "pi-telemetry",
	ai: "pi-ai",
	agent: "pi-agent-core",
	tui: "pi-tui",
	"coding-agent": "pi-coding-agent",
	mcp: "pi-mcp",
	codemode: "pi-codemode",
};
const vendor = path.join(root, "vendor");
const npm = (args, cwd = root) => execFileSync("npm", args, { cwd, encoding: "utf8", shell: process.platform === "win32" }).trim();
const sha512 = (file) => `sha512-${createHash("sha512").update(fs.readFileSync(file)).digest("base64")}`;

// package/package.json from an npm tarball (ustar entries: 512-byte header, size in octal at 124).
function tarballManifest(file) {
	const tar = gunzipSync(fs.readFileSync(file));
	for (let at = 0; at + 512 <= tar.length; ) {
		const name = tar.toString("utf8", at, at + 100).replace(/\0.*$/s, "");
		if (!name) break;
		const size = Number.parseInt(tar.toString("utf8", at + 124, at + 136).replace(/\0.*$/s, "").trim() || "0", 8);
		if (name === "package/package.json") return JSON.parse(tar.toString("utf8", at + 512, at + 512 + size));
		at += 512 + Math.ceil(size / 512) * 512;
	}
	throw new Error(`${file} has no package/package.json`);
}

const argv = process.argv.slice(2);
const up = argv.indexOf("--upstream");
const upstream = up >= 0 ? argv[up + 1] : undefined;
if (up >= 0 && !/^\d+\.\d+\.\d+$/.test(upstream ?? "")) throw new Error("--upstream needs an exact version, e.g. --upstream 1.0.1");
const server = upstream ? undefined : path.resolve(argv[0] ?? path.join(root, "..", "midnight.server"));

fs.rmSync(vendor, { recursive: true, force: true });
fs.mkdirSync(vendor);
const pkgPath = path.join(root, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
pkg.dependencies ??= {};
pkg.overrides = {};
const provenance = { source: upstream ? "upstream" : "fork", packedAt: new Date().toISOString(), packages: [] };
if (server) {
	try {
		provenance.fork = { path: server, commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: server, encoding: "utf8" }).trim() };
	} catch {
		provenance.fork = { path: server, commit: "unknown" };
	}
}

for (const [dir, name] of Object.entries(PACKAGES)) {
	const full = `@earendil-works/${name}`;
	let file;
	let origin;
	if (upstream) {
		file = npm(["pack", "--silent", "--pack-destination", vendor, `${full}@${upstream}`]).split(/\r?\n/).pop();
		const published = npm(["view", `${full}@${upstream}`, "dist.integrity"]);
		const actual = sha512(path.join(vendor, file));
		if (published !== actual) throw new Error(`${full}@${upstream}: tarball integrity ${actual} does not match the registry's ${published}`);
		origin = `https://registry.npmjs.org/${full}/-/${name}-${upstream}.tgz`;
	} else {
		const src = path.join(server, "packages", dir);
		if (!fs.existsSync(path.join(src, "dist"))) throw new Error(`${src} is not built; run npm run build in midnight.server first`);
		file = npm(["pack", "--silent", "--pack-destination", vendor], src).split(/\r?\n/).pop();
		origin = `fork:${path.relative(root, src).replace(/\\/g, "/")}`;
	}
	const manifest = tarballManifest(path.join(vendor, file));
	provenance.packages.push({ name: full, version: manifest.version, file, integrity: sha512(path.join(vendor, file)), license: manifest.license ?? "UNKNOWN", origin });
	pkg.dependencies[full] = `file:vendor/${file}`;
	pkg.overrides[full] = `$${full}`; // transitive ^x.y.z resolve to the same tarball
	console.log(`packed ${full}@${manifest.version} -> vendor/${file}`);
}

const versions = new Set(provenance.packages.map((p) => p.version));
if (versions.size !== 1) throw new Error(`mixed core versions: ${[...versions].join(", ")}`);
fs.writeFileSync(path.join(vendor, "PROVENANCE.json"), `${JSON.stringify(provenance, null, "\t")}\n`);
pkg.dependencies = Object.fromEntries(Object.entries(pkg.dependencies).sort(([a], [b]) => a.localeCompare(b)));
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, "\t")}\n`);
console.log(`vendor/PROVENANCE.json written (${provenance.source}); now run npm install`);
