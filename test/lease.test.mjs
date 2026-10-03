// C02 acceptance: an old epoch cannot input; takeover, lock and session switch revoke; background work yields to the user.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createScreenLease, LeaseBusyError } from "../src/windows/lease.mjs";

test("one owner, increasing epochs, revocation invalidates the old epoch", async () => {
	let t = 0;
	const armed = [];
	const lease = createScreenLease({ now: () => t, arm: async (e) => armed.push(e), disarm: async () => armed.push("off") });
	const a = await lease.acquire("m1", { title: "Q3 brief" });
	assert.equal(lease.valid("m1", a.epoch), true);
	await assert.rejects(lease.acquire("m2"), LeaseBusyError);
	await lease.revokeAll("esc");
	assert.equal(lease.valid("m1", a.epoch), false, "the takeover makes the old epoch stale");
	const b = await lease.acquire("m2");
	assert.ok(b.epoch > a.epoch);
	t += 60000;
	assert.equal(lease.current(), null, "expired leases are not current");
	const c = await lease.acquire("m1");
	assert.ok(c.epoch > b.epoch);
	assert.deepEqual(armed.filter((x) => x !== "off"), [a.epoch, b.epoch, c.epoch]);
});

test("background missions never take the screen from an active user", async () => {
	const lease = createScreenLease({ userIdleMs: () => 800 });
	await assert.rejects(lease.acquire("bg", { background: true }), (e) => e.code === "USER_ACTIVE");
	assert.ok(await lease.acquire("fg", { background: false }));
});

test("the input helper rejects input without the armed epoch", { skip: process.platform !== "win32" }, async () => {
	const helper = fileURLToPath(new URL("../src/tools/input-helper.ps1", import.meta.url));
	const p = spawn("powershell.exe", ["-NoProfile", "-NoLogo", "-MTA", "-ExecutionPolicy", "Bypass", "-File", helper], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
	const lines = [];
	let buf = "";
	p.stdout.setEncoding("utf8");
	p.stdout.on("data", (d) => {
		buf += d;
		let i;
		while ((i = buf.indexOf("\n")) >= 0) {
			lines.push(buf.slice(0, i).trim());
			buf = buf.slice(i + 1);
		}
	});
	const send = async (o) => {
		const n = lines.length;
		p.stdin.write(`${JSON.stringify(o)}\n`);
		const t = Date.now();
		while (lines.length === n) {
			if (Date.now() - t > 30000) throw new Error("helper did not answer");
			await new Promise((r) => setTimeout(r, 20));
		}
		return lines.at(-1);
	};
	try {
		assert.equal(await send({ op: "ping" }), "ok");
		assert.match(await send({ op: "move", x: 1, y: 1, epoch: 1 }), /no screen lease/);
		assert.equal(await send({ op: "arm", epoch: 5 }), "ok");
		assert.match(await send({ op: "move", x: 1, y: 1, epoch: 4 }), /stale screen lease epoch 4/);
		assert.match(await send({ op: "key", combo: "a" }), /stale/);
		assert.equal(await send({ op: "disarm" }), "ok");
		assert.match(await send({ op: "type", text: "x", epoch: 5 }), /no screen lease/);
	} finally {
		p.kill();
	}
});
