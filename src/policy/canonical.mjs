// Canonical intent identity (plan ch. 06): paths, recipients, accounts and attachment hashes are normalized before
// hashing, so an approval binds to exactly what will happen and any change produces a different intent.
import { createHash } from "node:crypto";
import path from "node:path";

export const sha256 = (data) => `sha256:${createHash("sha256").update(data).digest("hex")}`;

/** JSON with sorted keys; undefined dropped; strings NFC-normalized. */
export function stableStringify(value) {
	if (value === null || typeof value !== "object") {
		if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
		if (typeof value === "number" && !Number.isFinite(value)) return "null";
		return JSON.stringify(value) ?? "null";
	}
	if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : stableStringify(v))).join(",")}]`;
	const keys = Object.keys(value)
		.filter((k) => value[k] !== undefined)
		.sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

/** Normalize an email address for comparison: trim, lowercase, strip a display name ("Sam <sam@x.test>"). */
export function normalizeAddress(a) {
	const s = String(a ?? "").trim();
	const m = s.match(/<([^>]+)>\s*$/);
	return (m ? m[1] : s).trim().toLowerCase();
}

/** Windows-aware path normalization for comparing and hashing (not a security check: see files.mjs for realpath). */
export function normalizePath(p) {
	if (!p) return "";
	let n = path.resolve(String(p));
	if (process.platform === "win32") n = n.replace(/\//g, "\\").toLowerCase();
	return n.replace(/[\\/]+$/, "") || n;
}

export function intentHash(tool, canonicalArgs) {
	return sha256(stableStringify({ tool, args: canonicalArgs }));
}
