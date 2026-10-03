// Secret redaction for logs, diagnostics and support bundles (plan ch. 17, P05). Pattern-based plus any secret values
// registered at runtime; a redacted bundle is previewed before anything leaves the device.
const PATTERNS = [
	[/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]"],
	[/\b(sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g, "[key]"],
	[/\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, "[key]"],
	[/\b(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/g, "[token]"],
	[/\bAKIA[0-9A-Z]{16}\b/g, "[aws-key]"],
	[/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, "[token]"],
	[/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, "[jwt]"],
	[/(token|api[_-]?key|password|passwd|secret|authorization)(["'\s:=]+)(?!Bearer \[redacted\])([^\s"',;]{6,})/gi, "$1$2[redacted]"],
	[/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/g, "$1[user]:[pass]@"],
];

const registered = new Set();

export function registerSecret(value) {
	if (typeof value === "string" && value.length >= 6) registered.add(value);
}

export function redact(input) {
	let s = typeof input === "string" ? input : JSON.stringify(input);
	for (const v of registered) s = s.split(v).join("[secret]");
	for (const [re, rep] of PATTERNS) s = s.replace(re, rep);
	return s;
}
