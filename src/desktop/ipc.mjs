// The shell's IPC gate (plan ch. 04, R01). One channel, a closed method table, and four checks before anything runs:
// the sender is the capsule's own webContents, its frame is the app's index.html, the envelope validates (version,
// size, schema) and sequence numbers only move forward within a page load.
import { IPC_CHANNEL, validateRequest } from "../contracts/ipc.mjs";

/**
 * @param {{ ipcMain: object, isTrusted: (event) => boolean, shell: Record<string, Function>, host: (method: string, params: object, event: object) => Promise<any>, log?: Function }} o
 */
export function createIpcRouter(o) {
	const lastSeq = new Map(); // webContents id -> last sequence number
	o.ipcMain.handle(IPC_CHANNEL, async (event, envelope) => {
		if (!o.isTrusted(event)) {
			o.log?.("rejected IPC from an untrusted sender", event.senderFrame?.url);
			return { ok: false, error: "untrusted sender" };
		}
		const id = event.sender.id;
		const v = validateRequest(envelope, { lastSeq: lastSeq.get(id) ?? 0 });
		if (!v.ok) {
			o.log?.("rejected IPC", v.error);
			return { ok: false, error: v.error };
		}
		lastSeq.set(id, envelope.seq);
		try {
			const result = v.route === "shell" ? await o.shell[v.method](v.params, event) : await o.host(v.method, v.params, event);
			return { ok: true, result: result ?? null };
		} catch (err) {
			return { ok: false, error: String(err?.message ?? err) };
		}
	});
	return {
		/** A reloaded page starts its sequence again. */
		reset: (webContentsId) => lastSeq.delete(webContentsId),
	};
}
