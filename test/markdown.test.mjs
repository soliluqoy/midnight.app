import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const window = {};
vm.runInNewContext(fs.readFileSync(new URL("../src/ui/md.js", import.meta.url), "utf8"), { window });
const md = window.md;

test("Markdown links and citations retain balanced parentheses and escaped query strings", () => {
	const url = "https://example.test/a_(b)?x=1&y=2";
	const html = md.render(`[Page](${url})\n\nSee [1].\n\n1. [Source](${url})`);
	assert.equal((html.match(/href="https:\/\/example.test\/a_\(b\)\?x=1&amp;y=2"/g) ?? []).length, 3);
	assert.equal(md.refs(`1. [Source](${url})`)[1], url);
	assert.match(md.render("See https://example.test/a_(b)."), /href="https:\/\/example.test\/a_\(b\)"/);
});

test("source extraction ignores code and numbered lists preserve their starting value", () => {
	assert.equal(Object.keys(md.refs("```\n1. https://wrong.test\n```\nSee [1]")).length, 0);
	assert.match(md.render("4. Fourth\n5. Fifth"), /^<ol start="4">/);
	assert.match(md.render("[`Code`](https://example.test)"), /<a[^>]*><code>Code<\/code><\/a>/);
});

test("formatting never rewrites link attributes or permits raw HTML and unsafe protocols", () => {
	assert.match(md.render("[Page](https://example.test/**literal**)"), /href="https:\/\/example.test\/\*\*literal\*\*"/);
	const html = md.render('<script>alert(1)</script> [Bad](javascript:alert(1))');
	assert.doesNotMatch(html, /<script|href="javascript:/);
	assert.match(html, /&lt;script&gt;/);
});
