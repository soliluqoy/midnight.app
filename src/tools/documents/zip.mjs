// Minimal ZIP reader and writer for Office documents (XLSX, DOCX, PPTX are ZIP containers). The reader enforces
// limits on entry count, total expansion and compression ratio so a malformed or hostile archive cannot exhaust
// memory. The writer is deterministic: same content, same bytes, same hash.
import zlib from "node:zlib";

export const LIMITS = { maxEntries: 5000, maxTotal: 200 * 1024 * 1024, maxRatio: 200, maxEntry: 100 * 1024 * 1024 };

export class ArchiveError extends Error {}

/** Parse the central directory. Returns { entries: Map(name -> entry), read(name) -> Buffer }. */
export function readZip(buf, limits = LIMITS) {
	if (!Buffer.isBuffer(buf) || buf.length < 22) throw new ArchiveError("not a zip archive");
	let eocd = -1;
	for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
		if (buf.readUInt32LE(i) === 0x06054b50) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new ArchiveError("not a zip archive (no end of central directory)");
	const count = buf.readUInt16LE(eocd + 10);
	const cdSize = buf.readUInt32LE(eocd + 12);
	const cdOffset = buf.readUInt32LE(eocd + 16);
	if (count > limits.maxEntries) throw new ArchiveError(`archive has ${count} entries (limit ${limits.maxEntries})`);
	if (cdOffset === 0xffffffff || cdOffset + cdSize > buf.length) throw new ArchiveError("unsupported or corrupt archive (zip64 or bad offsets)");
	const entries = new Map();
	let p = cdOffset;
	let total = 0;
	for (let i = 0; i < count; i++) {
		if (buf.readUInt32LE(p) !== 0x02014b50) throw new ArchiveError("corrupt central directory");
		const method = buf.readUInt16LE(p + 10);
		const crc = buf.readUInt32LE(p + 16);
		const csize = buf.readUInt32LE(p + 20);
		const usize = buf.readUInt32LE(p + 24);
		const nlen = buf.readUInt16LE(p + 28);
		const xlen = buf.readUInt16LE(p + 30);
		const clen = buf.readUInt16LE(p + 32);
		const local = buf.readUInt32LE(p + 42);
		const name = buf.toString("utf8", p + 46, p + 46 + nlen);
		p += 46 + nlen + xlen + clen;
		if (name.includes("..") || name.startsWith("/") || /^[a-z]:/i.test(name)) throw new ArchiveError(`unsafe entry name ${name}`);
		if (usize > limits.maxEntry) throw new ArchiveError(`entry ${name} is too large (${usize} bytes)`);
		if (csize > 0 && usize / csize > limits.maxRatio) throw new ArchiveError(`entry ${name} expands ${Math.round(usize / csize)}x (limit ${limits.maxRatio}x)`);
		total += usize;
		if (total > limits.maxTotal) throw new ArchiveError(`archive expands beyond ${limits.maxTotal} bytes`);
		entries.set(name, { name, method, crc, csize, usize, local });
	}
	const read = (name) => {
		const e = entries.get(name);
		if (!e) return undefined;
		if (buf.readUInt32LE(e.local) !== 0x04034b50) throw new ArchiveError(`corrupt local header for ${name}`);
		const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
		const raw = buf.subarray(start, start + e.csize);
		let out;
		if (e.method === 0) out = Buffer.from(raw);
		else if (e.method === 8) out = zlib.inflateRawSync(raw, { maxOutputLength: Math.min(limits.maxEntry, e.usize + 1024) });
		else throw new ArchiveError(`unsupported compression method ${e.method} in ${name}`);
		if (out.length !== e.usize) throw new ArchiveError(`size mismatch in ${name}`);
		if ((zlib.crc32(out) >>> 0) !== e.crc >>> 0) throw new ArchiveError(`checksum mismatch in ${name}`);
		return out;
	};
	return { entries, read, text: (name) => read(name)?.toString("utf8") };
}

const DOS_TIME = 0; // 00:00:00
const DOS_DATE = (2026 - 1980) << 9 | (1 << 5) | 1; // 2026-01-01: fixed so output is reproducible

/** Build a zip from [{ name, data }] (deflated unless tiny). */
export function writeZip(files) {
	const locals = [];
	const central = [];
	let offset = 0;
	for (const f of files) {
		const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, "utf8");
		const name = Buffer.from(f.name, "utf8");
		const deflated = data.length > 64 ? zlib.deflateRawSync(data, { level: 9 }) : null;
		const method = deflated && deflated.length < data.length ? 8 : 0;
		const body = method === 8 ? deflated : data;
		const crc = zlib.crc32(data) >>> 0;
		const lh = Buffer.alloc(30);
		lh.writeUInt32LE(0x04034b50, 0);
		lh.writeUInt16LE(20, 4);
		lh.writeUInt16LE(0x0800, 6); // UTF-8 names
		lh.writeUInt16LE(method, 8);
		lh.writeUInt16LE(DOS_TIME, 10);
		lh.writeUInt16LE(DOS_DATE, 12);
		lh.writeUInt32LE(crc, 14);
		lh.writeUInt32LE(body.length, 18);
		lh.writeUInt32LE(data.length, 22);
		lh.writeUInt16LE(name.length, 26);
		lh.writeUInt16LE(0, 28);
		locals.push(lh, name, body);
		const ch = Buffer.alloc(46);
		ch.writeUInt32LE(0x02014b50, 0);
		ch.writeUInt16LE(20, 4);
		ch.writeUInt16LE(20, 6);
		ch.writeUInt16LE(0x0800, 8);
		ch.writeUInt16LE(method, 10);
		ch.writeUInt16LE(DOS_TIME, 12);
		ch.writeUInt16LE(DOS_DATE, 14);
		ch.writeUInt32LE(crc, 16);
		ch.writeUInt32LE(body.length, 20);
		ch.writeUInt32LE(data.length, 24);
		ch.writeUInt16LE(name.length, 28);
		ch.writeUInt32LE(offset, 42);
		central.push(ch, name);
		offset += 30 + name.length + body.length;
	}
	const cd = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(files.length, 8);
	end.writeUInt16LE(files.length, 10);
	end.writeUInt32LE(cd.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, cd, end]);
}

// ---- tiny XML helpers shared by the Office readers/writers ----
export const xmlEscape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
export const xmlUnescape = (s) =>
	String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e) =>
		e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1))) : { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[e.toLowerCase()],
	);
/** Attributes of the first tag in `tag` text: <c r="A1" t="s"> -> { r: "A1", t: "s" }. */
export function attrs(tag) {
	const out = {};
	for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = xmlUnescape(m[2]);
	return out;
}
