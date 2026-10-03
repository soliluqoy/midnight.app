const $ = (id) => document.getElementById(id);
const cap = $("cap");

let cur = "idle"; // idle | chat | mission | read | settings
let signedIn = true; // true once a model is available
let prev = "chat";
let accel = "Ctrl+Alt+M";
const RANK = { idle: 0, chat: 1, mission: 2, settings: 2, read: 3 };
const TEXT_SIZES = [0.9, 1, 1.15, 1.3, 1.45, 1.6];
let prefs = { textSize: 1, autoExpand: true, highContrast: false };
let running = false;
let hasMission = false;
let answer = ""; // latest assistant message (Markdown), streamed
let finalAnswer = "";
let planId, askId;
let steps = []; // {title, detail, tag, st}
let hosts = new Set();
let t0 = 0;
let tFirst = 0;
let timer;
let clip = null; // {kind:"url"|"text", value}

const inMission = () => cur === "mission" || cur === "read";

// ---------- capsule state ----------
async function setState(s) {
	if (s === cur) return;
	const grow = RANK[s] > RANK[cur];
	if (s === "settings" && cur !== "settings") prev = cur;
	cur = s;
	if (grow) {
		await midnight.size(s); // make room, then animate open
		cap.dataset.s = s;
	} else {
		cap.dataset.s = s; // animate closed, then shrink the window
		setTimeout(() => cur === s && midnight.size(s), 850);
	}
	if (s === "chat") {
		checkClipboard();
		setTimeout(async () => {
			await midnight.focus();
			$("box").focus();
		}, 350);
	}
}
const mood = (m) => {
	cap.dataset.m = m;
	$("idleSt").textContent = signedIn ? ({ idle: "idle", work: "working", ask: "needs you", done: "done" }[m] ?? m) : "sign in";
};
const foot = (f) => (cap.dataset.f = f);

// Sizes come from main (zoom- and screen-aware) as CSS variables.
async function applyDims() {
	const d = await midnight.dims();
	for (const [k, [w, h]] of Object.entries(d)) {
		document.documentElement.style.setProperty(`--w-${k}`, `${w}px`);
		document.documentElement.style.setProperty(`--h-${k}`, `${h}px`);
	}
}
function applyPrefs(s) {
	prefs = { ...prefs, ...s };
	document.body.dataset.contrast = prefs.highContrast ? "high" : "";
}

// ---------- pieces ----------
const clock = () => {
	const s = Math.floor((Date.now() - t0) / 1000);
	$("mTime").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
function feed(ic, cls, tx) {
	const d = document.createElement("div");
	d.className = `fl ${cls}`;
	const ts = new Date();
	d.innerHTML = `<span class="ts"></span><span class="ic"></span><span class="tx"></span>`;
	d.children[0].textContent = `${String(ts.getMinutes()).padStart(2, "0")}:${String(ts.getSeconds()).padStart(2, "0")}`;
	d.children[1].textContent = ic;
	d.children[2].textContent = tx;
	d.title = tx;
	$("feed").append(d);
	while ($("feed").children.length > 40) $("feed").firstChild.remove();
}
function renderSteps() {
	$("steps").textContent = "";
	steps.forEach((s) => {
		const li = document.createElement("li");
		li.dataset.st = s.st ?? "todo";
		li.innerHTML = `<i class="si"></i><div><b></b><span></span></div><em class="tag" hidden></em>`;
		li.querySelector("b").textContent = s.title;
		li.querySelector("span").textContent = s.note ?? s.detail ?? "";
		const tag = li.querySelector(".tag");
		if (s.tag) {
			tag.hidden = false;
			tag.textContent = s.tag === "approval" ? "asks first" : s.tag;
			if (s.tag === "approval") tag.classList.add("edge");
		}
		$("steps").append(li);
	});
}
const lit = (id) => $(id).classList.add("lit");
const host = (u) => {
	try {
		return new URL(/^[a-z]+:\/\//i.test(u) ? u : `https://${u}`).host.replace(/^www\./, "");
	} catch {
		return u;
	}
};
const clip40 = (s, n = 40) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function describe(name, a = {}) {
	if (name === "search") {
		const qs = a.queries ?? [];
		return ["⌕", "look", `search › ${qs.map((q) => `“${clip40(q, 36)}”`).join(" · ")}`];
	}
	if (name === "read_pages") {
		const hs = (a.urls ?? []).map(host);
		for (const h of hs) hosts.add(h);
		return ["◎", "look", `read ${hs.length} page${hs.length === 1 ? "" : "s"} › ${hs.join(", ")}`];
	}
	if (name === "user_browser") {
		if (a.action === "open") {
			for (const u of a.urls ?? []) hosts.add(host(u));
			return ["↗", "act", `your browser › open ${(a.urls ?? []).map(host).join(", ")}`];
		}
		return ["◎", "look", a.action === "current_page" ? "your browser › read the page you're on" : "your browser › check open windows"];
	}
	const where = name === "computer" ? "desktop" : "browser";
	const at = a.x !== undefined ? ` (${Math.round(a.x)},${Math.round(a.y)})` : "";
	switch (a.action) {
		case "elements":
			return ["◎", "look", `${where} › map controls${a.window ? ` · ${clip40(a.window, 30)}` : ""}`];
		case "click_element":
			return ["▸", "act", `${where} › click control #${a.id}`];
		case "set_value":
			return ["▸", "act", `${where} › fill #${a.id} “${clip40(a.text ?? "", 30)}”`];
		case "zoom":
			return ["◎", "look", `${where} › zoom in`];
		case "read_text":
			return ["◎", "look", `${where} › read text${a.window ? ` · ${clip40(a.window, 30)}` : ""}`];
		case "windows":
			return ["◎", "look", `${where} › list windows`];
		case "focus_window":
			return ["▸", "act", `${where} › switch to ${clip40(a.window ?? "", 30)}`];
		case "launch":
			return ["▸", "act", `${where} › open ${clip40(a.target ?? "", 34)}`];
		case "session":
			return ["◎", "look", `${where} › check sign-in · ${host(a.url ?? "")}`];
		case "navigate":
			hosts.add(host(a.url));
			return ["◎", "look", `${where} › open ${host(a.url)}`];
		case "read":
			return ["◎", "look", `${where} › read page`];
		case "screenshot":
			return ["◎", "look", `${where} › look at the screen`];
		case "click":
		case "double_click":
		case "right_click":
			return ["▸", "act", `${where} › ${a.action.replace("_", " ")}${at}`];
		case "type":
			return ["▸", "act", `${where} › type “${(a.text ?? "").slice(0, 40)}”`];
		case "key":
			return ["▸", "act", `${where} › press ${a.key}`];
		default:
			return ["▸", "act", `${where} › ${a.action ?? name}${at}`];
	}
}

// ---------- the answer panel ----------
let drawQueued = false;
function drawAnswer() {
	if (drawQueued) return;
	drawQueued = true;
	requestAnimationFrame(() => {
		drawQueued = false;
		const el = $("ans");
		const text = running ? answer : finalAnswer;
		el.hidden = !text.trim();
		if (el.hidden) return;
		const stick = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
		el.innerHTML = md.render(text) + (running ? '<span class="caret"></span>' : "");
		if (running && stick) el.scrollTop = el.scrollHeight;
	});
}
$("ans").addEventListener("click", (e) => {
	const a = e.target.closest("a[href]");
	if (!a) return;
	e.preventDefault();
	midnight.openExternal(a.getAttribute("href"));
});

// ---------- mission lifecycle ----------
function resetTurn(text) {
	running = true;
	answer = "";
	finalAnswer = "";
	tFirst = 0;
	steps = [];
	renderSteps();
	$("prompt").textContent = text;
	$("doneText").textContent = "";
	delete cap.dataset.log;
	t0 = Date.now();
	clock();
	clearInterval(timer);
	timer = setInterval(clock, 1000);
	mood("work");
	foot("run");
	drawAnswer();
}

function startMission(text) {
	hasMission = true;
	hosts = new Set();
	$("feed").textContent = "";
	for (const id of ["cBrowser", "cYours", "cDesk"]) $(id).classList.remove("lit");
	$("mTitle").textContent = text.replace(/^\?+\s*/, "");
	$("mTitle").title = text;
	$("mLabel").textContent = text.startsWith("??") ? "DEEP RESEARCH" : text.startsWith("?") ? "QUICK ANSWER" : "MISSION";
	remember(text);
	resetTurn(text);
	setState("mission");
	midnight.send(text);
}

function followUp(text) {
	remember(text);
	feed("▸", "act", `follow-up · ${clip40(text, 60)}`);
	resetTurn(text);
	if (!inMission()) setState("mission");
	midnight.send(text);
}

function finish(kind, heading, text) {
	running = false;
	clearInterval(timer);
	clock();
	mood(kind === "warn" ? "ask" : "done");
	$("doneH").textContent = heading;
	$("doneH").style.color = kind === "warn" ? "var(--amber)" : "";
	finalAnswer = answer.trim();
	$("doneText").textContent = kind === "warn" || !finalAnswer ? text : "";
	drawAnswer();
	renderSteps();
	const done = steps.filter((s) => s.st === "done").length;
	const rc = $("receipts");
	rc.textContent = "";
	const chip = (t, title) => {
		const s = document.createElement("span");
		s.textContent = t;
		if (title) s.title = title;
		rc.append(s);
	};
	if (steps.length) chip(`${done}/${steps.length} steps`);
	if (tFirst) chip(`first words ${((tFirst - t0) / 1000).toFixed(1)}s`, "Time until the answer started to appear");
	const hs = [...hosts];
	if (hs.length) chip(`${hs.length} site${hs.length === 1 ? "" : "s"}`, hs.join("\n"));
	$("doneSub").textContent = `${$("mTime").textContent} · legacy engine`;
	$("mLabel").textContent = "FINISHED";
	foot("done");
	if (cur === "idle") {
		setState("mission");
		notify(heading, finalAnswer || text);
	} else if (cur === "mission" && prefs.autoExpand && kind !== "warn" && finalAnswer.length > 1200) {
		setState("read");
	}
	if (cur !== "idle") setTimeout(() => $("reply").focus(), 400);
}

function notify(title, body) {
	try {
		const n = new Notification(`midnight.server · ${title}`, { body: body.replace(/[#*_`>[\]]/g, "").slice(0, 180), silent: true });
		n.onclick = () => {
			midnight.focus();
			if (!inMission()) setState("mission");
		};
	} catch {}
}

function newTask() {
	mood("idle");
	foot("none");
	hasMission = false;
	running = false;
	answer = finalAnswer = "";
	drawAnswer();
	midnight.reset();
	setState("chat");
}

function copyAnswer() {
	const t = finalAnswer || answer;
	if (!t) return;
	midnight.copy(t);
	$("copy").textContent = "Copied ✓";
	setTimeout(() => ($("copy").textContent = "Copy"), 1400);
}

// ---------- prompt history (per viewer; optional) ----------
const HKEY = "midnight.history";
let history = [];
try {
	history = JSON.parse(localStorage.getItem(HKEY) ?? "[]");
} catch {}
let hIdx = -1;
function remember(t) {
	history = [t, ...history.filter((x) => x !== t)].slice(0, 30);
	hIdx = -1;
	try {
		localStorage.setItem(HKEY, JSON.stringify(history));
	} catch {}
}

// ---------- clipboard: offer to summarize a copied link or text ----------
async function checkClipboard() {
	clip = null;
	const c = $("chipClip");
	c.hidden = true;
	let t = "";
	try {
		t = (await midnight.clipboard()).trim();
	} catch {}
	if (/^https?:\/\/\S+$/i.test(t)) {
		clip = { kind: "url", value: t };
		c.textContent = `⤓ summarize ${clip40(host(t), 22)}`;
	} else if (t.length > 280) {
		clip = { kind: "text", value: t };
		c.textContent = `⤓ summarize copied text`;
	}
	if (clip) {
		c.hidden = false;
		c.title = clip.kind === "url" ? clip.value : `${t.slice(0, 200)}…`;
	}
}
$("chipClip").onclick = () => {
	if (!clip) return;
	const t =
		clip.kind === "url"
			? `Summarize this page: ${clip.value}`
			: `Summarize this text I copied (key points, then anything I should act on):\n\n${clip.value}`;
	$("chipClip").hidden = true;
	startMission(t);
};

// ---------- input ----------
$("box").onkeydown = (e) => {
	const box = $("box");
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		const t = box.value.trim();
		if (!t) return;
		box.value = "";
		startMission(t);
	} else if (e.key === "Escape") {
		setState("idle");
	} else if (e.key === "ArrowUp" && (box.selectionStart === 0 || !box.value) && history.length) {
		e.preventDefault();
		hIdx = Math.min(history.length - 1, hIdx + 1);
		box.value = history[hIdx];
	} else if (e.key === "ArrowDown" && hIdx >= 0 && box.selectionStart === box.value.length) {
		e.preventDefault();
		hIdx -= 1;
		box.value = hIdx >= 0 ? history[hIdx] : "";
	}
};
$("reply").onkeydown = (e) => {
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		const t = $("reply").value.trim();
		if (!t || running) return;
		$("reply").value = "";
		followUp(t);
	}
};
$("reply").oninput = () => {
	const r = $("reply");
	r.style.height = "auto";
	r.style.height = `${Math.min(110, r.scrollHeight + 2)}px`;
};

function stepTextSize(dir) {
	const z = prefs.textSize;
	let i = TEXT_SIZES.findIndex((v) => v >= z - 0.001);
	if (i < 0) i = TEXT_SIZES.length - 1;
	const next = dir === 0 ? 1 : TEXT_SIZES[Math.max(0, Math.min(TEXT_SIZES.length - 1, i + dir))];
	midnight.textSize(next).then((v) => applyPrefs({ textSize: v }));
}
const toggleRead = () => {
	if (cur === "read") setState("mission");
	else if (hasMission) setState("read");
};

document.addEventListener("keydown", (e) => {
	const typing = e.target.matches?.("textarea, input");
	if (e.ctrlKey && !e.altKey && (e.key === "=" || e.key === "+")) return e.preventDefault(), stepTextSize(1);
	if (e.ctrlKey && !e.altKey && e.key === "-") return e.preventDefault(), stepTextSize(-1);
	if (e.ctrlKey && !e.altKey && e.key === "0") return e.preventDefault(), stepTextSize(0);
	if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "e" && hasMission) return e.preventDefault(), toggleRead();
	if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "c") return e.preventDefault(), copyAnswer();
	if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "l" && inMission() && !running) return e.preventDefault(), newTask();
	if (!typing && inMission() && e.key === "Escape" && !running) return setState("idle");
	// 1-9 open the numbered source of a finished answer
	if (!typing && !e.ctrlKey && !e.altKey && /^[1-9]$/.test(e.key) && finalAnswer) {
		const u = md.refs(finalAnswer)[e.key];
		if (u) midnight.openExternal(u);
	}
});

$("bMin").onclick = () => setState("idle");
$("bPeek").onclick = () => midnight.peek();
$("bRead").onclick = toggleRead;
$("bLog").onclick = () => {
	if (cap.dataset.log) delete cap.dataset.log;
	else cap.dataset.log = "1";
};
$("stop").onclick = () => midnight.abort();
$("again").onclick = newTask;
$("copy").onclick = copyAnswer;
$("planYes").onclick = () => {
	midnight.decide(planId, true);
	feed("▸", "ok", `approved · ${steps.length} steps`);
	mood("work");
	foot("run");
};
$("planNo").onclick = () => {
	midnight.decide(planId, false);
	foot("run");
};
$("askYes").onclick = () => {
	midnight.decide(askId, true);
	feed("✓", "ok", `approved · ${$("askTitle").textContent}`);
	mood("work");
	foot("run");
};
$("askNo").onclick = () => {
	midnight.decide(askId, false);
	feed("✕", "warn", `declined · ${$("askTitle").textContent}`);
	mood("work");
	foot("run");
};
$("login").onclick = () => openSettings();
$("gearChat").onclick = () => openSettings();
$("gearMission").onclick = () => openSettings();
$("chipModel").onclick = () => openSettings("model");

function openSettings(section) {
	setState("settings");
	window.renderSettings?.(section);
}
function closeSettings() {
	setState(prev === "settings" || prev === "idle" ? "chat" : prev);
}
window.closeSettings = closeSettings;

function summon() {
	if (!signedIn) {
		openSettings("accounts");
		return;
	}
	if (cur === "settings") return closeSettings();
	if (cur === "idle") setState(hasMission ? "mission" : "chat");
	else if (cur === "chat") setState("idle");
	else if (!running && cap.dataset.f === "done") newTask();
	else setState("idle");
}
$("l-idle").onclick = summon;

// ---------- events from the agent ----------
midnight.onAgent((m) => {
	switch (m.type) {
		case "summon":
			summon();
			break;
		case "start":
			break;
		case "assistant_start":
			answer = "";
			drawAnswer();
			break;
		case "text":
			if (!tFirst) tFirst = Date.now();
			answer += m.delta;
			drawAnswer();
			break;
		case "plan": {
			steps = m.steps.map((s) => ({ ...s, st: "todo" }));
			renderSteps();
			if (m.auto) {
				feed("▸", "ok", `plan · ${steps.length} steps · read-only, running`);
				if (!inMission()) setState("mission");
				break;
			}
			planId = m.id;
			const gated = steps.some((s) => s.tag === "approval");
			const parts = [];
			if (m.usesComputer) parts.push("uses your screen");
			parts.push(gated ? "sends are marked: asks before it sends" : "reads only; your question goes to the model you chose");
			$("planNote").textContent = (m.summary ? `${m.summary} · ` : "") + parts.join(" · ");
			mood("ask");
			foot("plan");
			feed("▸", "look", "plan ready · waiting for your OK");
			if (!inMission()) setState("mission");
			break;
		}
		case "progress": {
			const s = steps[m.step];
			if (!s) break;
			// a step starting means the ones before it are finished (the model doesn't have to say so)
			if (m.status === "active") for (const x of steps.slice(0, m.step)) if (x.st !== "skipped") x.st = "done";
			s.st = m.status;
			if (m.note) s.note = m.note;
			renderSteps();
			feed(m.status === "done" ? "✓" : "▸", m.status === "done" ? "ok" : "act", `${m.status} · ${s.title}${m.note ? ` — ${m.note}` : ""}`);
			break;
		}
		case "ask":
			askId = m.id;
			$("askTitle").textContent = m.title;
			$("askDetail").textContent = m.detail ?? "";
			$("askYes").textContent = m.approveLabel ?? "Approve";
			$("askNo").textContent = m.declineLabel ?? "Decline";
			mood("ask");
			foot("ask");
			feed("!", "warn", `needs approval · ${m.title}`);
			if (!inMission()) setState("mission");
			break;
		case "tool_start": {
			if (["plan", "progress", "ask"].includes(m.name)) break;
			lit(m.name === "computer" ? "cDesk" : m.name === "user_browser" ? "cYours" : "cBrowser");
			const [ic, cls, tx] = describe(m.name, m.args);
			feed(ic, cls, tx);
			break;
		}
		case "tool_end":
			if (m.isError && running) feed("!", "warn", `${m.name} failed`);
			else if (m.name === "search" && m.urls) feed("✓", "ok", `${m.urls.length} results`);
			break;
		case "open-settings":
			openSettings();
			break;
		case "corner":
			document.body.dataset.corner = m.corner;
			break;
		case "settings":
			applyPrefs(m.settings);
			break;
		case "model":
			signedIn = !!m.model;
			setChip(m);
			break;
		case "error":
			feed("!", "warn", m.message.slice(0, 80));
			if (running) finish("warn", "Something went wrong", m.message);
			break;
		case "takeover":
			if (hasMission && running) finish("warn", "You took over", "Stopped. Nothing further will run.");
			break;
		case "done":
			if (running) finish("ok", "Done", "Finished.");
			break;
		case "relayout":
			applyDims().then(() => midnight.size(cur));
			break;
	}
});

function setChip(c) {
	$("chipModel").textContent = c.model || "no model";
	$("idleSt").textContent = c.model ? ({ idle: "idle", work: "working", ask: "needs you", done: "done" }[cap.dataset.m] ?? "idle") : "sign in";
}
window.setAccel = (a) => {
	accel = a.replace("CommandOrControl", "Ctrl");
	$("hint").textContent = `${accel} · Esc closes`;
};
window.applyPrefs = applyPrefs;

async function init() {
	await applyDims();
	await midnight.size("idle");
	const s = await midnight.init();
	signedIn = !!s.hasModel;
	document.body.dataset.corner = s.settings.corner;
	applyPrefs(s.settings);
	window.setAccel(s.settings.hotkey);
	setChip(s.current);
}
init();
