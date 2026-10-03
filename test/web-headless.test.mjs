// Headless web worker (eval runner): result pages and articles parse without Electron, with the shell's output shape.
import assert from "node:assert/strict";
import test from "node:test";
import { htmlToText, parseSerp } from "../src/tools/web-text.mjs";
import { createHeadlessWeb, headlessWebOps } from "../src/tools/web-headless.mjs";

const DDG = `<html><body>
<div class="result results_links"><h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fen%2Fabout%2Fprevious-releases&amp;rut=x">Node.js &mdash; <b>Releases</b></a></h2>
<a class="result__snippet" href="#">Major Node.js versions enter <b>Current</b> release status&hellip;</a></div>
<div class="result"><h2><a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Ad</a></h2></div>
<div class="result"><h2><a href="https://example.org/b" class="result__a">Second</a></h2><a class="result__snippet">Two</a></div>
</body></html>`;

const BING = `<ol><li class="b_algo" data-x><h2><a href="https://www.bing.com/ck/a?!&amp;u=a1${Buffer.from("https://sqlite.org/wal.html").toString("base64url")}&amp;ntb=1">Write-Ahead Logging</a></h2><div class="b_caption"><p>WAL mode &amp; durability</p></div></li></ol>`;

const ARTICLE = `<!doctype html><html><head><title>WAL &amp; you</title><meta name="description" content="About WAL"></head><body>
<nav><a href="/">Home</a> Menu Menu</nav><script>var x = "<p>not text</p>";</script>
<article><h1>Write-Ahead Logging</h1><p>${"The WAL file holds changes until a checkpoint. ".repeat(12)}</p>
<ul><li>Readers do not block writers.</li><li>Writers do not block readers.</li></ul>
<table><tr><th>Mode</th><th>Durable</th></tr><tr><td>FULL</td><td>yes</td></tr></table>
<pre>PRAGMA journal_mode=WAL;</pre></article><footer>Copyright</footer></body></html>`;

test("headless web: result pages parse to clean links; ads and redirects are unwrapped or dropped", () => {
	const d = parseSerp("duckduckgo", DDG);
	assert.deepEqual(d.results.map((r) => r.url), ["https://nodejs.org/en/about/previous-releases", "https://example.org/b"]);
	assert.equal(d.results[0].title, "Node.js — Releases");
	assert.match(d.results[0].snippet, /Current release status…/);
	assert.equal(d.blocked, false);
	const b = parseSerp("bing", BING);
	assert.deepEqual(b.results, [{ title: "Write-Ahead Logging", url: "https://sqlite.org/wal.html", snippet: "WAL mode & durability" }]);
});

test("headless web: article text keeps headings, lists, tables and code and drops chrome and scripts", () => {
	const r = htmlToText(ARTICLE);
	assert.equal(r.title, "WAL & you");
	assert.equal(r.desc, "About WAL");
	assert.match(r.text, /^# Write-Ahead Logging/);
	assert.match(r.text, /- Readers do not block writers\./);
	assert.match(r.text, /\| FULL \| yes \|/);
	assert.match(r.text, /```\nPRAGMA journal_mode=WAL;\n```/);
	assert.doesNotMatch(r.text, /Menu|Copyright|not text/);
});

test("headless web: tools return the shell's shape; failed loads are reported, not evidence", async () => {
	const fake = async (url) => {
		const page = (body, type = "text/html") => ({ ok: true, url, headers: new Headers({ "content-type": type }), text: async () => body });
		if (url.startsWith("https://html.duckduckgo.com/")) return page(DDG);
		if (url === "https://sqlite.org/wal.html") return page(ARTICLE);
		return { ok: false, status: 404, url, headers: new Headers(), text: async () => "" };
	};
	const ops = headlessWebOps(createHeadlessWeb({ fetch: fake }));
	const s = await ops["tool.search"]({ queries: ["node releases"] });
	assert.match(s.content[0].text, /## node releases {2}\(duckduckgo\)\n1\. Node\.js — Releases/);
	assert.equal(s.details.urls.length, 2);
	const r = await ops["tool.read_pages"]({ urls: ["sqlite.org/wal.html", "https://missing.test/x"], query: "WAL readers" });
	assert.match(r.content[0].text, /\[1\] WAL & you\nhttps:\/\/sqlite\.org\/wal\.html/);
	assert.match(r.content[0].text, /\[2\] https:\/\/missing\.test\/x\nCould not load: HTTP 404/);
	assert.deepEqual(r.details.pages.map((p) => p.url), ["https://sqlite.org/wal.html"]);
	await assert.rejects(ops["fetch.page"]({ url: "file:///c:/x" }), /only http/);
});
