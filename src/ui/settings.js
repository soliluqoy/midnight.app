(() => {
	const root = document.getElementById("l-settings");
	const api = window.midnight;
	let S; // latest snapshot from main
	let q = ""; // account search
	let busy = ""; // provider id being logged in
	let showAll = false;
	let keyFor = ""; // provider id whose API-key box is open
	let modal; // open auth prompt; kept across re-renders
	let page = "main"; // main | welcome
	let extra = { sources: [], grants: [], watches: [], memory: [], recipes: [], connectors: [], skills: [] };
	const POPULAR = ["openai-codex", "anthropic", "github-copilot", "openai", "google", "xai", "openrouter", "mistral", "deepseek", "groq"];
	let status = { text: "", err: false };
	let updateReady = false;
	let scrollTo;

	const h = (tag, props = {}, ...kids) => {
		const el = document.createElement(tag);
		for (const [k, v] of Object.entries(props)) {
			if (k === "class") el.className = v;
			else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
			else if (v !== undefined && v !== false) el.setAttribute(k, v === true ? "" : v);
		}
		for (const k of kids.flat()) if (k != null) el.append(k.nodeType ? k : document.createTextNode(k));
		return el;
	};

	const pretty = (acc) => acc.replace("CommandOrControl", "Ctrl").replace("Super", "Win");
	const save = async (patch) => {
		const r = await api.settings.set(patch);
		S.settings = r.settings;
		S.current = r.current;
		if (r.error) setStatus(r.error, true);
		if (patch.hotkey && !r.error) window.setAccel(r.settings.hotkey);
		window.applyPrefs?.(r.settings);
		render();
	};
	function setStatus(text, err = false) {
		status = { text, err };
		render();
	}
	const attempt = (fn, ok) => async () => {
		try {
			await fn();
			if (ok) setStatus(ok);
		} catch (err) {
			setStatus(String(err.message ?? err), true);
		}
		await loadExtra();
		render();
	};

	async function loadExtra() {
		const safe = (p) => p.catch(() => []);
		const [sources, grants, watches, memory, recipes, connectors, skills] = await Promise.all([
			safe(api.sources.list()),
			safe(api.grants.list()),
			safe(api.watches.list()),
			safe(api.memory.list({})),
			safe(api.recipes.list()),
			safe(api.connectors.list()),
			safe(api.skills.list()),
		]);
		extra = { sources, grants, watches, memory, recipes, connectors, skills };
	}
	async function refresh() {
		S = await api.settings.get();
		await loadExtra();
		render();
	}

	// In-page dropdown: native <select> popups don't open reliably in a transparent frameless window.
	let openMenu;
	const closeMenu = () => {
		openMenu?.remove();
		openMenu = undefined;
	};
	document.addEventListener("pointerdown", (e) => {
		if (openMenu && !e.target.closest(".dd-menu, .dd")) closeMenu();
	});
	function dropdown({ value, groups, onPick, empty = "—", label }) {
		const all = groups.flatMap((g) => g.items);
		const cur = all.find((i) => i.value === value);
		const btn = h("button", { class: "dd", type: "button", "aria-haspopup": "listbox", "aria-label": label }, h("span", {}, cur ? cur.label : empty), h("i", { "aria-hidden": "true" }, "▾"));
		btn.onclick = () => {
			if (openMenu) return closeMenu();
			const menu = h("div", { class: "dd-menu", role: "listbox" });
			for (const g of groups) {
				if (g.label) menu.append(h("div", { class: "dd-g" }, g.label));
				for (const it of g.items) {
					menu.append(
						h("button", { class: `dd-i${it.value === value ? " sel" : ""}`, type: "button", role: "option", "aria-selected": String(it.value === value), onclick: () => { closeMenu(); onPick(it.value); } }, it.label, it.hint ? h("small", {}, it.hint) : null),
					);
				}
			}
			root.append(menu);
			openMenu = menu;
			const r = btn.getBoundingClientRect(), rr = root.getBoundingClientRect();
			const room = rr.bottom - r.bottom - 8;
			const up = room < 200 && r.top - rr.top > room;
			menu.style.maxHeight = `${Math.max(120, Math.min(260, up ? r.top - rr.top - 8 : room))}px`;
			menu.style.right = `${rr.right - r.right}px`;
			menu.style.minWidth = `${Math.max(160, r.width)}px`;
			if (up) menu.style.bottom = `${rr.bottom - r.top + 4}px`;
			else menu.style.top = `${r.bottom - rr.top + 4}px`;
			(menu.querySelector(".sel") ?? menu.querySelector("button"))?.focus();
		};
		return btn;
	}
	function toggle(on, fn, label) {
		return h("button", { class: `switch${on ? " on" : ""}`, role: "switch", "aria-checked": String(on), "aria-label": label, onclick: fn });
	}
	function segmented(value, items, onPick, label) {
		return h(
			"div",
			{ class: "seg", role: "radiogroup", "aria-label": label },
			...items.map((it) => h("button", { class: it.value === value ? "on" : "", role: "radio", "aria-checked": String(it.value === value), title: it.title ?? "", onclick: () => onPick(it.value) }, it.label)),
		);
	}
	const field = (label, sub, control) => h("div", { class: "field" }, h("label", {}, label, sub ? h("small", {}, sub) : null), control);
	const sec = (id, title, ...kids) => h("div", { class: "sec", id: `sec-${id}` }, h("h6", {}, title), ...kids);

	// ---------- first run: what goes where, model, folders, autonomy ----------
	function welcome() {
		const signedIn = !!S.current?.model;
		return h(
			"div",
			{ class: "sbody" },
			sec(
				"welcome",
				"WELCOME",
				h("p", { class: "hint" }, "midnight runs on this computer: your missions, rules, files and memory stay here. When it works on a task, your request and the parts of files you let it read go to the AI model you choose. A cloud model's provider receives that text; a local model keeps it on this computer."),
				h("p", { class: "hint" }, "Nothing is sent, saved over, bought or posted without either a rule you created or your OK on the exact action."),
			),
			sec("w-model", "1 · CHOOSE A MODEL", signedIn ? h("p", { class: "hint" }, `Ready: ${S.current.model}.`) : h("p", { class: "hint warn" }, "Sign in below (Accounts) or set up a local model under Models."), modelSection(true)),
			sec(
				"w-folders",
				"2 · CHOOSE FOLDERS (OPTIONAL)",
				h("p", { class: "hint" }, "midnight can only read folders you pick here. Skip this for web-only use."),
				h("div", { class: "row" }, h("button", { class: "sb", onclick: attempt(() => api.sources.pick("source"), "Folder added.") }, "Add a folder to read"), h("button", { class: "sb", onclick: attempt(() => api.sources.pick("output"), "Folder added.") }, "Add a folder for drafts")),
				...extra.sources.map((s) => h("p", { class: "hint" }, `${s.purpose === "output" ? "drafts → " : "reads "}${s.path}`)),
			),
			sec("w-mode", "3 · HOW MUCH MIDNIGHT DOES ON ITS OWN", autonomyField()),
			h("div", { class: "row2" }, h("button", { class: "sb pri", onclick: async () => { await save({ onboarded: true }); page = "main"; window.closeSettings(); } }, signedIn ? "Start" : "Finish later")),
			accountsSection(),
		);
	}

	function autonomyField() {
		const st = S.settings;
		return h(
			"div",
			{},
			segmented(
				st.mode,
				[
					{ value: "ask", label: "Ask me", title: "Reads and drafts in its own workspace freely; asks before anything else." },
					{ value: "prepare", label: "Prepare for me", title: "Also saves drafts into your draft folders; asks before anything leaves the computer." },
					{ value: "rules", label: "Act within my rules", title: "Uses the rules you created for recurring actions and lets watches prepare work." },
				],
				(v) => save({ mode: v }),
				"Autonomy",
			),
			h("p", { class: "hint" }, st.mode === "ask" ? "Ask me: approved reads run without prompts; anything that changes files or leaves the computer asks." : st.mode === "prepare" ? "Prepare for me: also saves drafts into your draft folders; sending or posting still asks unless a rule covers it." : "Act within my rules: actions covered by a rule run without asking; watches may prepare drafts. Everything else still asks."),
		);
	}

	// ---------- sections ----------
	function modelSection(compact = false) {
		const groups = new Map();
		for (const m of S.models) {
			if (!groups.has(m.providerName)) groups.set(m.providerName, []);
			groups.get(m.providerName).push(m);
		}
		const sel = dropdown({
			label: "Model",
			value: `${S.current.provider}|${S.current.model}`,
			empty: S.models.length ? "Choose a model" : "Sign in below to see models",
			groups: [...groups].map(([name, list]) => ({ label: name, items: list.map((m) => ({ value: `${m.provider}|${m.id}`, label: m.name, hint: m.local ? "local" : m.vision ? "" : "no vision" })) })),
			onPick: (v) => {
				const [provider, ...id] = v.split("|");
				save({ provider, model: id.join("|") });
			},
		});
		const cur = S.models.find((m) => m.provider === S.current.provider && m.id === S.current.model);
		if (compact) return h("div", {}, field("Model", "", sel));
		const st = S.settings;
		const local = st.local ?? {};
		const url = h("input", { class: "sinp", value: local.baseUrl ?? "", placeholder: "http://localhost:11434/v1", "aria-label": "Local endpoint address", onchange: (e) => save({ local: { baseUrl: e.target.value.trim() } }) });
		const lm = h("input", { class: "sinp", value: local.model ?? "", placeholder: "model name, e.g. qwen3:8b", "aria-label": "Local model name", onchange: (e) => save({ local: { model: e.target.value.trim() } }) });
		return sec(
			"model",
			"MODELS AND PRIVACY",
			field("Model", "Quick answers (start with ?) and the default for everything else", sel),
			field(
				"Task model",
				"Plans, computer use and research",
				dropdown({
					label: "Task model",
					value: st.taskModel ?? "",
					groups: [{ items: [{ value: "", label: "Automatic", hint: "stronger model when available" }] }, ...[...groups].map(([name, list]) => ({ label: name, items: list.filter((m) => !m.local).map((m) => ({ value: `${m.provider}|${m.id}`, label: m.name, hint: m.vision ? "" : "no vision" })) }))],
					onPick: (v) => save({ taskModel: v }),
				}),
			),
			cur && !cur.vision ? h("p", { class: "hint warn" }, "This model can't see images, so browser and screen screenshots won't work.") : null,
			field(
				"Thinking",
				"More thinking is slower and costs more",
				dropdown({ label: "Thinking", value: st.thinking, groups: [{ items: ["off", "low", "medium", "high"].map((v) => ({ value: v, label: v })) }], onPick: (v) => save({ thinking: v }) }),
			),
			field(
				"Where missions run",
				"Applies to new missions",
				segmented(
					st.privacy,
					[
						{ value: "cloud", label: "Cloud model", title: "Your request and the file text midnight reads go to your chosen provider." },
						{ value: "local", label: "Local only", title: "Only the local model below; public web pages may still be fetched." },
						{ value: "offline", label: "Offline", title: "Local model and local files only; no network." },
					],
					(v) => save({ privacy: v }),
					"Privacy",
				),
			),
			h("p", { class: "hint" }, "A local or offline mission never falls back to a cloud model. If the local model can't do it, midnight says so."),
			field("Local model", "An Ollama or compatible server on this computer", toggle(!!local.enabled, () => save({ local: { enabled: !local.enabled } }), "Use a local model")),
			local.enabled ? h("div", { class: "keyrow" }, url, lm) : null,
			local.enabled ? h("p", { class: "hint" }, "Quiet mode asks the server to unload the model when idle. midnight does not change your server's other settings.") : null,
		);
	}

	function keyRow(a) {
		const input = h("input", { class: "sinp", type: "password", placeholder: `Paste ${a.name} API key`, autocomplete: "off", spellcheck: "false", "aria-label": `${a.name} API key` });
		const go = () => {
			const key = input.value.trim();
			if (key) login(a.id, "api_key", key);
		};
		input.onkeydown = (e) => {
			if (e.key === "Enter") go();
			else if (e.key === "Escape") {
				e.stopPropagation();
				keyFor = "";
				render();
			}
		};
		setTimeout(() => !document.activeElement?.matches("input, textarea") && input.focus(), 30);
		return h(
			"div",
			{ class: "keyrow" },
			input,
			h("button", { class: "sb", title: "Paste from clipboard", onclick: async () => { input.value = (await api.clipboard.read()).trim(); input.focus(); } }, "Paste"),
			h("button", { class: "sb pri", onclick: go }, "Save"),
		);
	}

	function accountsSection() {
		const all = S.accounts;
		const collapsed = !q && !showAll;
		const list = all.filter((a) => (q ? `${a.name} ${a.id}`.toLowerCase().includes(q.toLowerCase()) : !collapsed || a.configured || POPULAR.includes(a.id)));
		const rows = list.flatMap((a) => {
			const isBusy = busy === a.id;
			const canOut = a.configured && (a.source === "stored" || a.source === "runtime");
			const row = h(
				"div",
				{ class: "acct" },
				h("i", { class: `sdot${a.configured ? " on" : ""}`, "aria-hidden": "true" }),
				h("div", { class: "n" }, a.name, a.configured && a.source === "environment" ? h("small", {}, `via ${a.label ?? "environment"}`) : null),
				isBusy
					? h("span", { class: "mono" }, "signing in…")
					: [
							!a.configured && a.oauth ? h("button", { class: "sb pri", onclick: () => login(a.id, "oauth") }, "Sign in") : null,
							a.apiKey ? h("button", { class: `sb${keyFor === a.id ? " on" : ""}`, onclick: () => { keyFor = keyFor === a.id ? "" : a.id; render(); } }, a.configured ? "Use API key" : "API key") : null,
							canOut ? h("button", { class: "sb danger", onclick: () => logout(a.id) }, "Sign out") : null,
						],
			);
			return keyFor === a.id && !isBusy ? [row, keyRow(a)] : [row];
		});
		return sec(
			"accounts",
			"ACCOUNTS",
			h("input", {
				class: "sinp",
				placeholder: "Search providers…",
				"aria-label": "Search providers",
				value: q,
				oninput: (e) => {
					q = e.target.value;
					const pos = e.target.selectionStart;
					render();
					const i = root.querySelector("#sec-accounts .sinp");
					i.focus();
					i.setSelectionRange(pos, pos);
				},
			}),
			h("div", {}, rows.length ? rows : h("p", { class: "hint" }, "No providers match.")),
			!q ? h("button", { class: "sb", onclick: () => { showAll = !showAll; render(); } }, showAll ? "Show fewer" : `Show all ${all.length} providers`) : null,
			h("p", { class: "hint" }, "Subscriptions sign in in your browser. API key: click it, paste the key, Save. Keys are stored where the midnight.server CLI keeps them."),
		);
	}

	function autonomySection() {
		return sec("autonomy", "AUTONOMY", autonomyField(), field("Desktop control", "Mouse and keyboard; always needs a plan you approve, and Esc takes over", dropdown({ label: "Desktop control", value: S.settings.computerUse, groups: [{ items: [{ value: "ask", label: "Ask in the plan" }, { value: "never", label: "Never" }] }], onPick: (v) => save({ computerUse: v }) })));
	}

	function sourcesSection() {
		return sec(
			"sources",
			"FOLDERS MIDNIGHT MAY USE",
			...extra.sources.map((s) => h("div", { class: "acct" }, h("div", { class: "n", title: s.path }, s.path, h("small", {}, s.purpose === "output" ? "reads and saves drafts" : "reads")), h("button", { class: "sb danger", onclick: attempt(() => api.sources.remove(s.id), "Removed.") }, "Remove"))),
			extra.sources.length ? null : h("p", { class: "hint" }, "No folders yet. midnight cannot read your files until you add one."),
			h("div", { class: "row" }, h("button", { class: "sb", onclick: attempt(() => api.sources.pick("source"), "Folder added.") }, "Add folder to read"), h("button", { class: "sb", onclick: attempt(() => api.sources.pick("output"), "Folder added.") }, "Add folder for drafts")),
		);
	}

	const EFFECT_LABEL = { "external.communication": "Send email", "local.write": "Save files", "local.move": "Move files", "read.connector": "Read connected accounts", "connector.write": "Change connected records", "browser.commit": "Submit on websites" };
	function rulesSection() {
		const label = h("input", { class: "sinp", placeholder: "Rule name, e.g. Weekly report to Sam", "aria-label": "Rule name" });
		const dest = h("input", { class: "sinp", placeholder: "Exact recipients or sites, comma separated", "aria-label": "Allowed recipients or sites" });
		let effect = "external.communication";
		let days = 30;
		const draft = () => ({ label: label.value.trim() || EFFECT_LABEL[effect], actionClasses: [effect], destinations: dest.value.split(",").map((x) => x.trim()).filter(Boolean), expiresInDays: days, limits: { maxActions: 50 } });
		return sec(
			"rules",
			"RULES",
			h("p", { class: "hint" }, "A rule lets midnight do one kind of action without asking, only for the recipients or sites you list, until it expires. Only you can create or widen a rule; revoking it takes effect immediately."),
			...extra.grants.map((g) =>
				h(
					"div",
					{ class: "acct" },
					h("div", { class: "n", title: `${g.actionClasses.join(", ")}${g.destinations.length ? ` → ${g.destinations.join(", ")}` : ""}` }, g.label, h("small", {}, `${g.missionId ? "this mission only" : `${g.used}${g.limits?.maxActions ? `/${g.limits.maxActions}` : ""} used`}${g.expiresAt ? ` · until ${new Date(g.expiresAt).toLocaleDateString()}` : ""}`)),
					h("button", { class: "sb danger", onclick: attempt(() => api.grants.revoke(g.id), "Rule revoked.") }, "Revoke"),
				),
			),
			h("div", { class: "keyrow" }, label),
			h(
				"div",
				{ class: "keyrow" },
				dropdown({ label: "Action", value: effect, groups: [{ items: Object.entries(EFFECT_LABEL).map(([value, l]) => ({ value, label: l })) }], onPick: (v) => (effect = v) }),
				segmented(days, [{ value: 1, label: "1d" }, { value: 7, label: "7d" }, { value: 30, label: "30d" }], (v) => (days = v), "Expires"),
			),
			h("div", { class: "keyrow" }, dest, h("button", { class: "sb pri", onclick: attempt(() => { const d = draft(); if (["external.communication", "browser.commit"].includes(effect) && !d.destinations.length) throw new Error("List the exact recipients or sites this rule allows."); return api.grants.create(d); }, "Rule created.") }, "Create")),
		);
	}

	function watchesSection() {
		const label = h("input", { class: "sinp", placeholder: "Name, e.g. Pricing page", "aria-label": "Watch name" });
		const target = h("input", { class: "sinp", placeholder: "https://… or a folder path inside your folders", "aria-label": "What to watch" });
		let every = { unit: "hours", n: 6 };
		let onChange = "notify";
		return sec(
			"watches",
			"WATCHES",
			h("p", { class: "hint" }, "A watch checks a page, folder or connected account on a schedule without using the model. When nothing changes it stays silent; a change lands in the attention queue (held during quiet hours)."),
			...extra.watches.map((w) => h("div", { class: "acct" }, h("div", { class: "n", title: JSON.stringify(w.source) }, w.label, h("small", {}, w.status)), h("button", { class: "sb", onclick: attempt(() => api.watches.setPaused({ watchId: w.id, paused: !w.paused })) }, w.paused ? "Resume" : "Pause"), h("button", { class: "sb danger", onclick: attempt(() => api.watches.remove(w.id), "Watch removed.") }, "Delete"))),
			h("div", { class: "keyrow" }, label),
			h("div", { class: "keyrow" }, target),
			h(
				"div",
				{ class: "keyrow" },
				segmented("6h", [{ value: "30m", label: "30m" }, { value: "6h", label: "6h" }, { value: "1d", label: "daily" }, { value: "wd", label: "weekdays" }], (v) => (every = { "30m": { unit: "minutes", n: 30 }, "6h": { unit: "hours", n: 6 }, "1d": { unit: "days", n: 1, at: "09:00" }, wd: { unit: "weekdays", n: 1, at: "08:30" } }[v]), "How often"),
				segmented("notify", [{ value: "notify", label: "Tell me" }, { value: "prepare", label: "Prepare an update" }], (v) => (onChange = v), "On change"),
				h(
					"button",
					{
						class: "sb pri",
						onclick: attempt(() => {
							const t = target.value.trim();
							const source = /^https?:\/\//i.test(t) ? { kind: "url", url: t } : { kind: "folder", path: t };
							return api.watches.create({ label: label.value.trim() || t.slice(0, 60), source, every, onChange, cooldownMinutes: 60 });
						}, "Watching."),
					},
					"Add",
				),
			),
		);
	}

	let editing = ""; // memory id being corrected
	function correctRow(m) {
		const input = h("input", { class: "sinp", value: m.text, "aria-label": "Correct this memory" });
		const go = () => input.value.trim() && attempt(() => api.memory.correct({ memoryId: m.id, text: input.value.trim() }), "Corrected.")().then(() => (editing = ""));
		input.onkeydown = (e) => e.key === "Enter" && go();
		setTimeout(() => input.focus(), 30);
		return h("div", { class: "keyrow" }, input, h("button", { class: "sb pri", onclick: go }, "Save"));
	}
	function memorySection() {
		const input = h("input", { class: "sinp", placeholder: "Something to remember, e.g. Save reports in Documents\\Reports", "aria-label": "Remember" });
		return sec(
			"memory",
			"MEMORY",
			h("p", { class: "hint" }, "Only confirmed memories are used, and only when relevant. A memory never grants permission."),
			...extra.memory.flatMap((m) => [
				h(
					"div",
					{ class: "acct" },
					h("div", { class: "n", title: `${m.why}${m.uses ? ` · used ${m.uses}×` : ""}` }, m.text, h("small", {}, m.confirmed ? `${m.kind}${m.uses ? ` · used ${m.uses}×` : ""}` : "suggested · not used yet")),
					m.confirmed ? null : h("button", { class: "sb pri", onclick: attempt(() => api.memory.confirm(m.id)) }, "Keep"),
					h("button", { class: "sb", onclick: () => { editing = editing === m.id ? "" : m.id; render(); } }, "Edit"),
					h("button", { class: "sb danger", onclick: attempt(() => api.memory.forget(m.id), "Forgotten.") }, "Forget"),
				),
				editing === m.id ? correctRow(m) : null,
			]),
			h("div", { class: "keyrow" }, input, h("button", { class: "sb pri", onclick: attempt(() => input.value.trim() && api.memory.remember({ text: input.value.trim(), kind: "preference" }), "Remembered.") }, "Remember")),
			h("button", { class: "sb", onclick: attempt(async () => api.clipboard.write(JSON.stringify(await api.memory.export(), null, 2)), "Memory copied as JSON.") }, "Export"),
		);
	}

	function routinesSection() {
		if (!extra.recipes.length) return null;
		return sec(
			"routines",
			"ROUTINES",
			...extra.recipes.map((r) =>
				h(
					"div",
					{ class: "acct" },
					h("div", { class: "n", title: `${r.template.goal}\nUses: ${r.template.tools.join(", ")}\nEffects: ${r.template.effects.join(", ")}` }, r.label, h("small", {}, r.reviewed ? "reviewed" : "review the steps before running")),
					r.reviewed ? null : h("button", { class: "sb", onclick: attempt(() => api.recipes.review({ recipeId: r.id }), "Reviewed.") }, "Mark reviewed"),
					r.reviewed ? h("button", { class: "sb pri", onclick: attempt(() => api.recipes.run({ recipeId: r.id, requestId: `req_${Date.now()}` }), "Started.") }, "Run") : null,
				),
			),
		);
	}

	function resourcesSection() {
		const st = S.settings;
		const qh = st.quietHours ?? {};
		return sec(
			"resources",
			"RESOURCES",
			field(
				"Profile",
				st.profile === "quiet" ? "Only your direct requests run; background work and local models rest" : st.profile === "focused" ? "Your active mission first; background suggestions wait" : st.profile === "burst" ? "More at once, for 30 minutes" : "One model task and bounded web work at a time",
				segmented(st.profile, [{ value: "quiet", label: "Quiet" }, { value: "balanced", label: "Balanced" }, { value: "focused", label: "Focused" }, { value: "burst", label: "Burst" }], (v) => save({ profile: v }), "Resource profile"),
			),
			field("Quiet hours", `${qh.from ?? "22:00"}–${qh.to ?? "07:00"} · updates wait until morning`, toggle(!!qh.enabled, () => save({ quietHours: { enabled: !qh.enabled } }), "Quiet hours")),
			field(
				"Budget per mission",
				"midnight stops starting new work at the cap and keeps what's done",
				segmented(st.budget?.costUsd ?? 2, [{ value: 0.5, label: "$0.50" }, { value: 2, label: "$2" }, { value: 10, label: "$10" }], (v) => save({ budget: { costUsd: v } }), "Budget"),
			),
		);
	}

	function behaviourSection() {
		const st = S.settings;
		const ta = h("textarea", { class: "sta", placeholder: "e.g. Reply in Spanish. Prefer official sources. Keep answers under 5 lines.", "aria-label": "Standing instructions", onchange: (e) => save({ instructions: e.target.value }) });
		ta.value = st.instructions;
		return sec(
			"behaviour",
			"BEHAVIOUR",
			field("Know where I was", "Tell midnight the window or page you were on when you opened it", toggle(st.shareContext, () => save({ shareContext: !st.shareContext }), "Know where I was")),
			field("Summon shortcut", "", hotkeyButton()),
			field("Capsule position", "", dropdown({ label: "Capsule position", value: st.corner, groups: [{ items: [{ value: "right", label: "Bottom right" }, { value: "left", label: "Bottom left" }] }], onPick: (v) => save({ corner: v }) })),
			field("Start with Windows", "Takes effect in the installed app", toggle(st.launchAtLogin, () => save({ launchAtLogin: !st.launchAtLogin }), "Start with Windows")),
			field("Standing instructions", "Added to every mission", null),
			ta,
		);
	}

	function hotkeyButton() {
		const b = h("button", { class: "sb" }, h("kbd", {}, pretty(S.settings.hotkey)), " change");
		b.onclick = () => {
			b.textContent = "Press the new shortcut… (Esc cancels)";
			const onKey = (e) => {
				e.preventDefault();
				e.stopPropagation();
				if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return;
				document.removeEventListener("keydown", onKey, true);
				if (e.key === "Escape") return render();
				const mods = [e.ctrlKey && "CommandOrControl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super"].filter(Boolean);
				const names = { ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", " ": "Space" };
				const key = names[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key);
				if (!mods.length) return setStatus("Use at least one of Ctrl, Alt, Shift or Win.", true);
				save({ hotkey: [...mods, key].join("+") });
			};
			document.addEventListener("keydown", onKey, true);
		};
		return b;
	}

	function readingSection() {
		const st = S.settings;
		const sizes = [0.9, 1, 1.15, 1.3, 1.45, 1.6].map((value, i) => ({ value, label: ["S", "M", "L", "XL", "2X", "3X"][i] }));
		const near = sizes.reduce((a, b) => (Math.abs(b.value - st.textSize) < Math.abs(a.value - st.textSize) ? b : a)).value;
		return sec(
			"reading",
			"READING",
			field("Text size", "Ctrl + / Ctrl − / Ctrl 0 anywhere in the capsule", segmented(near, sizes, (v) => save({ textSize: v }), "Text size")),
			field("High contrast", "Brighter text, stronger edges", toggle(st.highContrast, () => save({ highContrast: !st.highContrast }), "High contrast")),
			field("Reduce motion", "No breathing dot or morphing; instant changes", toggle(st.reducedMotion, () => save({ reducedMotion: !st.reducedMotion }), "Reduce motion")),
			field("Reading view for long answers", "Opens the wide view automatically · Ctrl+E toggles it", toggle(st.autoExpand, () => save({ autoExpand: !st.autoExpand }), "Reading view for long answers")),
			field("Answer length", "", segmented(st.answerLength, [{ value: "brief", label: "Brief" }, { value: "normal", label: "Normal" }, { value: "detailed", label: "Detailed" }], (v) => save({ answerLength: v }), "Answer length")),
		);
	}

	function webSection() {
		const st = S.settings;
		return sec(
			"web",
			"WEB",
			field("Search engine", "Falls back to the others if one blocks", dropdown({ label: "Search engine", value: st.searchEngine, groups: [{ items: [{ value: "google", label: "Google" }, { value: "bing", label: "Bing" }, { value: "duckduckgo", label: "DuckDuckGo" }] }], onPick: (v) => save({ searchEngine: v }) })),
			field("Fast page reading", "Fetch pages directly when possible; skip images, video, fonts and trackers", toggle(st.fastPages, () => save({ fastPages: !st.fastPages }), "Fast page reading")),
		);
	}

	function dataSection() {
		const st = S.settings;
		return sec(
			"data",
			"DATA",
			field("Export everything", "Missions, receipts, rules, watches and memory as JSON", h("button", { class: "sb", onclick: attempt(async () => { const r = await api.data.export(); setStatus(`Exported to ${r.file}`); }) }, "Export")),
			field("Delete finished missions' content", "Answers, evidence, drafts and transcripts. Records of actions that left the computer stay.", h("button", { class: "sb danger", onclick: () => confirm("Delete the content of finished missions?") && attempt(() => api.data.remove("history"), "Deleted.")() }, "Delete")),
			field("Delete all memory", "", h("button", { class: "sb danger", onclick: () => confirm("Forget everything midnight remembers?") && attempt(() => api.data.remove("memory"), "Memory deleted.")() }, "Delete")),
			field("Background browser", "Cookies, logins and cache used by midnight's browser", h("button", { class: "sb danger", onclick: attempt(() => api.data.clearBrowser(), "Browser data cleared.") }, "Clear")),
			field("Support bundle", "Preview what it contains, then save it. No prompts, files, screenshots or secrets.", h("button", { class: "sb", onclick: attempt(async () => { const p = await api.data.diagnostics(); if (confirm(`${p.note}\n\n${JSON.stringify(p.preview, null, 1).slice(0, 1500)}…\n\nSave it?`)) await api.data.saveDiagnostics(); }) }, "Preview")),
			field("App data folder", "", h("button", { class: "sb", onclick: () => api.data.openFolder() }, "Open")),
			field(
				"Updates",
				"Reads the public release list at most once a day; installs only signed builds, only when you ask and nothing is running",
				h(
					"div",
					{ class: "row" },
					segmented(st.updates ?? "notify", [{ value: "notify", label: "Tell me" }, { value: "off", label: "Off" }], (v) => save({ updates: v }), "Updates"),
					h("button", { class: "sb", onclick: attempt(async () => { const r = await api.updates.check(); updateReady = !!r.available; setStatus(r.error ? `Couldn't check: ${r.error}` : r.available ? `Version ${r.latest} is available.` : "You have the latest version."); }) }, "Check"),
					updateReady ? h("button", { class: "sb pri", onclick: attempt(async () => { const r = await api.updates.install(); setStatus(r.ok ? "Installing…" : r.reason, !r.ok); }) }, "Install") : null,
				),
			),
			field("Demo connectors", "Fixture CRM and mail for trying the sales-brief workflow. Nothing is really sent.", toggle(!!st.demoConnectors, () => save({ demoConnectors: !st.demoConnectors }).then(() => setStatus("Restart the engine (tray → Restart engine) to apply.")), "Demo connectors")),
			h("p", { class: "hint" }, "Shortcuts: ? quick · ?? deep research · ↑ last prompt · Ctrl+E reading view (click ⤢ again for evidence) · Ctrl+Shift+C copy · 1–9 open a source · Ctrl+L new task · Esc takes over"),
			h("p", { class: "hint" }, `midnight.app ${S.version} · engine ${S.engine} · ${S.dataDir}`),
		);
	}

	// ---------- actions ----------
	async function login(id, type, key) {
		busy = id;
		setStatus(key ? "Saving key…" : "Starting sign-in…");
		const r = await api.auth.login(id, type, key);
		busy = "";
		modal?.remove();
		modal = undefined;
		if (r.ok) keyFor = "";
		status = r.ok ? { text: "Signed in.", err: false } : { text: r.error === "Cancelled" ? "" : r.error, err: true };
		await refresh();
	}
	async function logout(id) {
		await api.auth.logout(id);
		status = { text: "Signed out.", err: false };
		await refresh();
	}

	function promptModal(m) {
		const p = m.prompt;
		let value = "";
		const done = (v) => {
			modal.remove();
			modal = undefined;
			api.auth.answer(m.id, v);
		};
		const box = h("div", { class: "box", role: "dialog" }, h("p", {}, p.message));
		if (p.kind === "select") box.append(h("div", { class: "opts" }, ...p.options.map((o) => h("button", { class: "sb", onclick: () => done(o.id) }, o.label, o.description ? h("small", { class: "mono" }, `  ${o.description}`) : null))));
		else {
			const input = h("input", { class: "sinp", type: p.kind === "secret" ? "password" : "text", placeholder: p.placeholder ?? "" });
			input.oninput = () => (value = input.value.trim());
			input.onkeydown = (e) => e.key === "Enter" && value && done(value);
			box.append(input, h("button", { class: "sb", onclick: async () => { input.value = (await api.clipboard.read()).trim(); value = input.value; input.focus(); } }, "Paste from clipboard"));
			setTimeout(() => input.focus(), 50);
		}
		const row = h("div", { class: "row2" }, h("button", { class: "sb", onclick: () => done(null) }, "Cancel"));
		if (p.kind !== "select") row.append(h("button", { class: "sb pri", onclick: () => value && done(value) }, "OK"));
		box.append(row);
		modal?.remove();
		modal = h("div", { class: "modal" }, box);
		root.append(modal);
	}

	api.on((m) => {
		if (m.kind === "auth-prompt") promptModal(m);
		else if (m.kind === "auth-event") {
			const e = m.event;
			if (e.type === "auth_url") setStatus("Finish signing in in your browser…");
			else if (e.type === "device_code") setStatus(`Go to ${e.verificationUri} and enter ${e.userCode}`);
			else if (e.type === "info" || e.type === "progress") setStatus(e.message);
		}
	});

	// ---------- render ----------
	function render() {
		if (!S) return;
		const keep = root.querySelector(".sbody")?.scrollTop ?? 0;
		root.textContent = "";
		root.append(
			h("div", { class: "sh" }, h("button", { class: "ib", title: "Back", "aria-label": "Back", onclick: () => window.closeSettings() }, "←"), h("b", {}, page === "welcome" ? "Welcome to midnight" : "Settings")),
			h(
				"div",
				{ id: "sStatus", class: `${status.text ? "on" : ""}${status.err ? " err" : ""}`, role: "status" },
				h("span", {}, status.text),
				busy ? h("button", { class: "sb", onclick: () => api.auth.cancel() }, "Cancel") : h("button", { class: "sb", "aria-label": "Dismiss", onclick: () => setStatus("") }, "✕"),
			),
			page === "welcome"
				? welcome()
				: h("div", { class: "sbody" }, autonomySection(), modelSection(), accountsSection(), sourcesSection(), rulesSection(), watchesSection(), memorySection(), routinesSection(), resourcesSection(), readingSection(), webSection(), behaviourSection(), dataSection()),
		);
		if (modal) root.append(modal);
		const body = root.querySelector(".sbody");
		if (body) body.scrollTop = keep;
		if (scrollTo) {
			root.querySelector(`#sec-${scrollTo}`)?.scrollIntoView();
			scrollTo = undefined;
		}
	}

	window.renderSettings = async (section) => {
		page = section === "welcome" ? "welcome" : "main";
		scrollTo = section === "welcome" ? undefined : section;
		status = { text: "", err: false };
		await refresh();
	};
})();
