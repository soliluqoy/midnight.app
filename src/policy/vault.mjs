// Credential references (plan ch. 17, P05). Secrets are encrypted by the OS through the shell (Electron safeStorage)
// and only references live in the database. If protected storage is unavailable the vault fails closed: it offers a
// session-only secret instead of writing plaintext. Secrets never enter prompts, logs or support bundles.
import { newId } from "../contracts/events.mjs";
import { registerSecret } from "./redaction.mjs";

export class VaultUnavailableError extends Error {}

export function createVault({ store, platform }) {
	const session = new Map(); // ref -> plaintext, never persisted
	return {
		async put(label, secret, { persist = true } = {}) {
			registerSecret(secret);
			const ref = newId("sec");
			if (!persist) {
				session.set(ref, secret);
				return { ref, persisted: false };
			}
			const r = await platform.call("vault.encrypt", { text: secret }).catch(() => ({ available: false }));
			if (!r.available) throw new VaultUnavailableError("Protected storage is not available on this computer; the secret can be kept for this session only.");
			store.run("INSERT INTO secrets (ref, label, ciphertext, created_at) VALUES (?, ?, ?, ?)", ref, label.slice(0, 120), r.ciphertext, new Date().toISOString());
			return { ref, persisted: true };
		},
		async get(ref) {
			if (session.has(ref)) return session.get(ref);
			const row = store.get("SELECT ciphertext FROM secrets WHERE ref = ?", ref);
			if (!row) return undefined;
			const r = await platform.call("vault.decrypt", { ciphertext: row.ciphertext });
			if (!r.available) throw new VaultUnavailableError("Protected storage is not available");
			registerSecret(r.text);
			return r.text;
		},
		remove(ref) {
			session.delete(ref);
			return store.run("DELETE FROM secrets WHERE ref = ?", ref).changes > 0;
		},
		list: () => store.all("SELECT ref, label, created_at FROM secrets ORDER BY created_at"),
	};
}
