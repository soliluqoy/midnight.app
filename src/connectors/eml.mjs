// RFC 5322 / MIME message writer and reader for local mail drafts (.eml opens in Outlook, Mail and Thunderbird).
import { createHash } from "node:crypto";

const b64 = (buf) => buf.toString("base64").replace(/.{76}/g, "$&\r\n");
const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);

/** @param {{ from?: string, to: string[], cc?: string[], subject: string, body: string, attachments?: {name:string,data:Buffer,type?:string}[], date?: Date }} m */
export function writeEml(m) {
	const boundary = `midnight-${createHash("sha256").update(m.subject + m.body).digest("hex").slice(0, 16)}`;
	const head = [
		m.from ? `From: ${m.from}` : null,
		`To: ${m.to.join(", ")}`,
		m.cc?.length ? `Cc: ${m.cc.join(", ")}` : null,
		`Subject: ${encodeHeader(m.subject)}`,
		`Date: ${(m.date ?? new Date()).toUTCString()}`,
		"X-Unsent: 1", // Outlook opens it as a draft ready to send
		"MIME-Version: 1.0",
		`Content-Type: multipart/mixed; boundary="${boundary}"`,
	].filter(Boolean);
	const parts = [`--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(Buffer.from(m.body, "utf8"))}`];
	for (const a of m.attachments ?? []) {
		parts.push(`--${boundary}\r\nContent-Type: ${a.type ?? "application/octet-stream"}; name="${encodeHeader(a.name)}"\r\nContent-Disposition: attachment; filename="${encodeHeader(a.name)}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(a.data)}`);
	}
	return Buffer.from(`${head.join("\r\n")}\r\n\r\n${parts.join("\r\n")}\r\n--${boundary}--\r\n`, "utf8");
}

/** Enough parsing to validate a draft we wrote: headers and attachment names/sizes. */
export function readEml(buf) {
	const text = buf.toString("utf8");
	const [head] = text.split("\r\n\r\n");
	const h = (name) => new RegExp(`^${name}: (.*)$`, "mi").exec(head)?.[1];
	const decode = (s) => s?.replace(/=\?UTF-8\?B\?([^?]+)\?=/g, (_, b) => Buffer.from(b, "base64").toString("utf8"));
	const attachments = [...text.matchAll(/Content-Disposition: attachment; filename="([^"]+)"\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)/g)].map((m) => {
		const data = Buffer.from(m[2].replace(/\r\n/g, ""), "base64");
		return { name: decode(m[1]), size: data.length, hash: `sha256:${createHash("sha256").update(data).digest("hex")}` };
	});
	return { to: (h("To") ?? "").split(/,\s*/).filter(Boolean), cc: (h("Cc") ?? "").split(/,\s*/).filter(Boolean), subject: decode(h("Subject")) ?? "", attachments };
}
