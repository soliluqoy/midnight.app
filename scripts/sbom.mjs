// Software bill of materials (plan ch. 03, F04): every installed package with version, integrity and license, plus the
// recorded source of the Pi core. Written to release/sbom.json (CycloneDX 1.5 JSON).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const provenance = JSON.parse(fs.readFileSync(path.join(root, "vendor", "PROVENANCE.json"), "utf8"));

const components = [];
for (const [key, v] of Object.entries(lock.packages)) {
	if (!key.startsWith("node_modules/") || v.dev) continue;
	const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
	let license = v.license;
	if (!license) {
		try {
			license = JSON.parse(fs.readFileSync(path.join(root, key, "package.json"), "utf8")).license;
		} catch {}
	}
	const core = provenance.packages.find((p) => p.name === name);
	components.push({
		type: "library",
		name,
		version: v.version,
		purl: `pkg:npm/${name.replace("@", "%40")}@${v.version}`,
		hashes: v.integrity ? [{ alg: v.integrity.split("-")[0].toUpperCase().replace("SHA", "SHA-"), content: Buffer.from(v.integrity.split("-").slice(1).join("-"), "base64").toString("hex") }] : [],
		licenses: license ? [{ license: { id: String(license) } }] : [],
		properties: core ? [{ name: "midnight:source", value: `${provenance.source} ${core.origin}` }] : undefined,
	});
}
const bom = {
	bomFormat: "CycloneDX",
	specVersion: "1.5",
	version: 1,
	metadata: { timestamp: new Date().toISOString(), component: { type: "application", name: pkg.name, version: pkg.version, licenses: [{ license: { id: pkg.license } }] } },
	components: components.sort((a, b) => a.name.localeCompare(b.name)),
};
fs.mkdirSync(path.join(root, "release"), { recursive: true });
fs.writeFileSync(path.join(root, "release", "sbom.json"), `${JSON.stringify(bom, null, 2)}\n`);
const unlicensed = components.filter((c) => !c.licenses.length).map((c) => c.name);
console.log(`release/sbom.json: ${components.length} runtime components${unlicensed.length ? `; no license field: ${unlicensed.join(", ")}` : ""}`);
