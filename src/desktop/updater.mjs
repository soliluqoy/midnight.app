// Safe updates (plan ch. 23, D01). Checks the public release feed at most once a day (or when asked), never installs
// in the middle of work: only at a checkpoint with no mission running or waiting, after a fresh backup, and only an
// installer whose SHA-512 matches the release manifest and whose Authenticode signature is valid. Unsigned builds are
// never auto-installed; the release page opens instead.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = "soliluqoy/midnight.app";
const newer = (a, b) => {
	const pa = a.replace(/^v/, "").split(".").map(Number);
	const pb = b.replace(/^v/, "").split(".").map(Number);
	for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
	return false;
};

export function verifySignature(file) {
	if (process.platform !== "win32") return Promise.resolve({ valid: false, reason: "signature checks run on Windows" });
	return new Promise((resolve) => {
		execFile(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-Command", `(Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g, "''")}') | Select-Object Status,@{n='Signer';e={$_.SignerCertificate.Subject}} | ConvertTo-Json -Compress`],
			{ windowsHide: true, timeout: 30000 },
			(err, out) => {
				if (err) return resolve({ valid: false, reason: err.message });
				try {
					const j = JSON.parse(out);
					resolve({ valid: j.Status === 0 || j.Status === "Valid", signer: j.Signer, status: j.Status });
				} catch {
					resolve({ valid: false, reason: "could not read the signature" });
				}
			},
		);
	});
}

/**
 * @param {{ version: string, fetchImpl?: typeof fetch, isBusy: () => Promise<boolean>, backup: () => Promise<any>, launch: (file: string) => void, openPage: (url: string) => void }} o
 */
export function createUpdater(o) {
	const fetchImpl = o.fetchImpl ?? fetch;
	let last = { checkedAt: 0, latest: undefined, error: undefined };

	async function check({ force = false } = {}) {
		if (!force && Date.now() - last.checkedAt < 24 * 3600000) return last;
		try {
			const r = await fetchImpl(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: "application/vnd.github+json", "user-agent": "midnight-updater" }, signal: AbortSignal.timeout(10000) });
			if (!r.ok) throw new Error(`release feed answered ${r.status}`);
			const rel = await r.json();
			const version = String(rel.tag_name ?? "").replace(/^v/, "");
			const asset = (n) => rel.assets?.find((a) => a.name === n)?.browser_download_url;
			last = { checkedAt: Date.now(), latest: version, available: newer(version, o.version), page: rel.html_url, installer: asset("midnight-setup-x64.exe"), manifest: asset("latest.yml") };
		} catch (err) {
			last = { ...last, checkedAt: Date.now(), error: String(err.message ?? err) };
		}
		return last;
	}

	async function install() {
		const info = await check({ force: true });
		if (!info.available) return { ok: false, reason: "You have the latest version." };
		if (await o.isBusy()) return { ok: false, reason: "Midnight is working on a mission; it will update when it is idle." };
		if (!info.installer || !info.manifest) {
			o.openPage(info.page);
			return { ok: false, reason: "This release has no verified installer; the release page is open." };
		}
		const manifest = await (await fetchImpl(info.manifest)).text();
		const want = /sha512:\s*(\S+)/.exec(manifest)?.[1];
		const file = path.join(os.tmpdir(), `midnight-setup-${info.latest}.exe`);
		const buf = Buffer.from(await (await fetchImpl(info.installer)).arrayBuffer());
		const got = createHash("sha512").update(buf).digest("base64");
		if (!want || got !== want) return { ok: false, reason: "The download does not match the release manifest; nothing was installed." };
		fs.writeFileSync(file, buf);
		const sig = await verifySignature(file);
		if (!sig.valid) {
			fs.rmSync(file, { force: true });
			o.openPage(info.page);
			return { ok: false, reason: `The installer is not signed (${sig.reason ?? sig.status}); it was not run. The release page is open.` };
		}
		await o.backup(); // a consistent copy of the mission store before the new version migrates it
		o.launch(file);
		return { ok: true, version: info.latest };
	}

	return { check, install, status: () => last };
}
