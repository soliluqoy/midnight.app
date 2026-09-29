(() => {
	const root = document.getElementById("l-settings");
	const api = midnight.settings;
	let S; // latest snapshot from main
	let q = ""; // account search
	let busy = ""; // provider id being logged in
	let showAll = false;
	const POPULAR = ["openai-codex", "anthropic", "github-copilot", "openai", "google", "xai", "openrouter", "mistral", "deepseek", "groq"];
	let status = { text: "", err: false };
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
		const r = await api.set(patch);
		S.settings = r.settings;
		S.current = r.current;
		if (r.error) setStatus(r.error, true);
		if (patch.hotkey && !r.error) window.setAccel(r.settings.hotkey);
		render();
	};
	function setStatus(text, err = false) {
		status = { text, err };
		render();
	}

	async function refresh() {
		S = await api.get();
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
	function dropdown({ value, groups, onPick, empty = "—" }) {
		const all = groups.flatMap((g) => g.items);
		const cur = all.find((i) => i.value === value);
		const btn = h("button", { class: "dd", type: "button" }, h("span", {}, cur ? cur.label : empty), h("i", {}, "▾"));
		btn.onclick = () => {
			if (openMenu) return closeMenu();
			const menu = h("div", { class: "dd-menu", role: "listbox" });
			for (const g of groups) {
				if (g.label) menu.append(h("div", { class: "dd-g" }, g.label));
				for (const it of g.items) {
					menu.append(
						h("button", { class: `dd-i${it.value === value ? " sel" : ""}`, type: "button", onclick: () => { closeMenu(); onPick(it.value); } }, it.label, it.hint ? h("small", {}, it.hint) : null),
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
			menu.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
		};
		return btn;
	}

	// ---------- sections ----------
	function modelSection() {
		const groups = new Map();
		for (const m of S.models) {
			if (!groups.has(m.providerName)) groups.set(m.providerName, []);
			groups.get(m.providerName).push(m);
		}
		const sel = dropdown({
			value: `${S.current.provider}|${S.current.model}`,
			empty: S.models.length ? "Choose a model" : "Sign in below to see models",
			groups: [...groups].map(([name, list]) => ({
				label: name,
				items: list.map((m) => ({ value: `${m.provider}|${m.id}`, label: m.name, hint: m.vision ? "" : "no vision" })),
			})),
			onPick: (v) => {
				const [provider, ...id] = v.split("|");
				save({ provider, model: id.join("|") });
			},
		});
		const cur = S.models.find((m) => m.provider === S.current.provider && m.id === S.current.model);
		const think = dropdown({
			value: S.settings.thinking,
			groups: [{ items: ["off", "low", "medium", "high"].map((v) => ({ value: v, label: v })) }],
			onPick: (v) => save({ thinking: v }),
		});
		return h(
			"div",
			{ class: "sec", id: "sec-model" },
			h("h6", {}, "MODEL"),
			h("div", { class: "field" }, h("label", {}, "Model"), sel),
			cur && !cur.vision ? h("p", { class: "hint warn" }, "This model can't see images, so browser and computer-use screenshots won't work. Pick one without “no vision”.") : null,
			h("div", { class: "field" }, h("label", {}, "Thinking", h("small", {}, "More thinking is slower and costs more")), think),
		);
	}

	function accountsSection() {
		const all = S.accounts;
		const collapsed = !q && !showAll;
		const list = all.filter((a) => (q ? `${a.name} ${a.id}`.toLowerCase().includes(q.toLowerCase()) : !collapsed || a.configured || POPULAR.includes(a.id)));
		const rows = list.map((a) => {
			const isBusy = busy === a.id;
			const canOut = a.configured && (a.source === "stored" || a.source === "runtime");
			return h(
				"div",
				{ class: "acct" },
				h("i", { class: `sdot${a.configured ? " on" : ""}` }),
				h("div", { class: "n" }, a.name, a.configured && a.source === "environment" ? h("small", {}, `via ${a.label ?? "environment"}`) : null),
				isBusy
					? h("span", { class: "mono" }, "signing in…")
					: [
							!a.configured && a.oauth ? h("button", { class: "sb pri", onclick: () => login(a.id, "oauth") }, "Sign in") : null,
							!a.configured && a.apiKey ? h("button", { class: "sb", onclick: () => login(a.id, "api_key") }, "API key") : null,
							canOut ? h("button", { class: "sb danger", onclick: () => logout(a.id) }, "Sign out") : null,
						],
			);
		});
		return h(
			"div",
			{ class: "sec", id: "sec-accounts" },
			h("h6", {}, "ACCOUNTS"),
			h("input", {
				class: "sinp",
				placeholder: "Search providers…",
				value: q,
				oninput: (e) => {
					q = e.target.value;
					const pos = e.target.selectionStart;
					render();
					const i = root.querySelector(".sinp");
					i.focus();
					i.setSelectionRange(pos, pos);
				},
			}),
			h("div", {}, rows.length ? rows : h("p", { class: "hint" }, "No providers match.")),
			!q ? h("button", { class: "sb", onclick: () => { showAll = !showAll; render(); } }, showAll ? "Show fewer" : `Show all ${all.length} providers`) : null,
			h("p", { class: "hint" }, "Subscriptions (ChatGPT, Claude, Copilot…) sign in in your browser. API keys are stored by midnight.server, shared with its CLI."),
		);
	}

	function toggle(on, fn) {
		return h("button", { class: `switch${on ? " on" : ""}`, role: "switch", "aria-checked": String(on), onclick: fn });
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
				if (!mods.length) {
					setStatus("Use at least one of Ctrl, Alt, Shift or Win.", true);
					return;
				}
				save({ hotkey: [...mods, key].join("+") });
			};
			document.addEventListener("keydown", onKey, true);
		};
		return b;
	}

	function behaviourSection() {
		const st = S.settings;
		const ta = h("textarea", {
			class: "sta",
			placeholder: "e.g. Reply in Spanish. Prefer official sources. Keep answers under 5 lines.",
			onchange: (e) => save({ instructions: e.target.value }),
		});
		ta.value = st.instructions;
		return h(
			"div",
			{ class: "sec", id: "sec-behaviour" },
			h("h6", {}, "BEHAVIOUR"),
			h(
				"div",
				{ class: "field" },
				h("label", {}, "Computer use", h("small", {}, "Mouse and keyboard on your desktop. Always needs an approved plan.")),
				dropdown({
					value: st.computerUse,
					groups: [{ items: [{ value: "ask", label: "Ask in the plan" }, { value: "never", label: "Never" }] }],
					onPick: (v) => save({ computerUse: v }),
				}),
			),
			h(
				"div",
				{ class: "field" },
				h("label", {}, "Know where I was", h("small", {}, "Tell midnight the window / page you were on when you opened it, so “summarize this” just works")),
				toggle(st.shareContext, () => save({ shareContext: !st.shareContext })),
			),
			h("div", { class: "field" }, h("label", {}, "Summon shortcut"), hotkeyButton()),
			h(
				"div",
				{ class: "field" },
				h("label", {}, "Capsule position"),
				dropdown({
					value: st.corner,
					groups: [{ items: [{ value: "right", label: "Bottom right" }, { value: "left", label: "Bottom left" }] }],
					onPick: (v) => save({ corner: v }),
				}),
			),
			h("div", { class: "field" }, h("label", {}, "Start with Windows", h("small", {}, "Takes effect in the installed app")), toggle(st.launchAtLogin, () => save({ launchAtLogin: !st.launchAtLogin }))),
			h("div", { class: "field" }, h("label", {}, "Standing instructions", h("small", {}, "Added to every mission"))),
			ta,
		);
	}

	function segmented(value, items, onPick) {
		return h(
			"div",
			{ class: "seg", role: "radiogroup" },
			...items.map((it) =>
				h("button", { class: it.value === value ? "on" : "", role: "radio", "aria-checked": String(it.value === value), title: it.title ?? "", onclick: () => onPick(it.value) }, it.label),
			),
		);
	}

	function readingSection() {
		const st = S.settings;
		const sizes = [
			{ value: 0.9, label: "S" },
			{ value: 1, label: "M" },
			{ value: 1.15, label: "L" },
			{ value: 1.3, label: "XL" },
			{ value: 1.45, label: "2X" },
			{ value: 1.6, label: "3X" },
		];
		const near = sizes.reduce((a, b) => (Math.abs(b.value - st.textSize) < Math.abs(a.value - st.textSize) ? b : a)).value;
		return h(
			"div",
			{ class: "sec", id: "sec-reading" },
			h("h6", {}, "READING"),
			h("div", { class: "field" }, h("label", {}, "Text size", h("small", {}, "Ctrl + / Ctrl − / Ctrl 0 anywhere in the capsule")), segmented(near, sizes, (v) => save({ textSize: v }))),
			h("div", { class: "field" }, h("label", {}, "High contrast", h("small", {}, "Brighter text, stronger edges")), toggle(st.highContrast, () => save({ highContrast: !st.highContrast }))),
			h("div", { class: "field" }, h("label", {}, "Reading view for long answers", h("small", {}, "Opens the wide view automatically · Ctrl+E toggles it")), toggle(st.autoExpand, () => save({ autoExpand: !st.autoExpand }))),
			h(
				"div",
				{ class: "field" },
				h("label", {}, "Answer length"),
				segmented(st.answerLength, [{ value: "brief", label: "Brief" }, { value: "normal", label: "Normal" }, { value: "detailed", label: "Detailed" }], (v) => save({ answerLength: v })),
			),
		);
	}

	function webSection() {
		const st = S.settings;
		return h(
			"div",
			{ class: "sec", id: "sec-web" },
			h("h6", {}, "WEB"),
			h(
				"div",
				{ class: "field" },
				h("label", {}, "Search engine", h("small", {}, "Falls back to the others if one blocks")),
				dropdown({
					value: st.searchEngine,
					groups: [{ items: [{ value: "google", label: "Google" }, { value: "bing", label: "Bing" }, { value: "duckduckgo", label: "DuckDuckGo" }] }],
					onPick: (v) => save({ searchEngine: v }),
				}),
			),
			h("div", { class: "field" }, h("label", {}, "Fast page reading", h("small", {}, "Skip images, video, fonts and trackers when reading")), toggle(st.fastPages, () => save({ fastPages: !st.fastPages }))),
			h(
				"div",
				{ class: "field" },
				h("label", {}, "Run read-only plans without asking", h("small", {}, "Plans that send or use the desktop always ask")),
				toggle(st.autoApproveReadOnly, () => save({ autoApproveReadOnly: !st.autoApproveReadOnly })),
			),
		);
	}

	function dataSection() {
		return h(
			"div",
			{ class: "sec", id: "sec-data" },
			h("h6", {}, "DATA"),
			h(
				"div",
				{ class: "field" },
				h("label", {}, "Background browser", h("small", {}, "Cookies, logins and cache used by the agent")),
				h("button", { class: "sb danger", onclick: async () => { await api.clearBrowser(); setStatus("Browser data cleared."); } }, "Clear"),
			),
			h("div", { class: "field" }, h("label", {}, "App data folder"), h("button", { class: "sb", onclick: () => api.openData() }, "Open")),
			h(
			"p",
			{ class: "hint" },
			"Shortcuts: ? quick · ?? deep research · ↑ last prompt · Ctrl+E reading view · Ctrl+Shift+C copy answer · 1–9 open a source · Ctrl+L new task",
		),
		h("p", { class: "hint" }, `midnight.app ${S.version} · ${S.dataDir}`),
		);
	}

	// ---------- actions ----------
	async function login(id, type) {
		busy = id;
		setStatus("Starting sign-in…");
		const r = await api.login(id, type);
		busy = "";
		status = r.ok ? { text: "Signed in.", err: false } : { text: r.error === "Cancelled" ? "" : r.error, err: true };
		await refresh();
	}
	async function logout(id) {
		await api.logout(id);
		status = { text: "Signed out.", err: false };
		await refresh();
	}

	// ---------- auth prompts and progress from the core ----------
	function promptModal(m) {
		const p = m.prompt;
		let value = "";
		const done = (v) => {
			modal.remove();
			midnight.decide(m.id, v);
		};
		const box = h("div", { class: "box" }, h("p", {}, p.message));
		if (p.kind === "select") {
			box.append(
				h(
					"div",
					{ class: "opts" },
					...p.options.map((o) => h("button", { class: "sb", onclick: () => done(o.id) }, o.label, o.description ? h("small", { class: "mono" }, `  ${o.description}`) : null)),
				),
			);
		} else {
			const input = h("input", { class: "sinp", type: p.kind === "secret" ? "password" : "text", placeholder: p.placeholder ?? "" });
			input.oninput = () => (value = input.value);
			input.onkeydown = (e) => e.key === "Enter" && value && done(value);
			box.append(input);
			setTimeout(() => input.focus(), 50);
		}
		const row = h("div", { class: "row2" }, h("button", { class: "sb", onclick: () => done(null) }, "Cancel"));
		if (p.kind !== "select") row.append(h("button", { class: "sb pri", onclick: () => value && done(value) }, "OK"));
		box.append(row);
		const modal = h("div", { class: "modal" }, box);
		root.append(modal);
	}

	midnight.onAgent((m) => {
		if (m.type === "auth_prompt") promptModal(m);
		else if (m.type === "auth_event") {
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
			h("div", { class: "sh" }, h("button", { class: "ib", title: "Back", onclick: () => window.closeSettings() }, "←"), h("b", {}, "Settings")),
			h(
				"div",
				{ id: "sStatus", class: `${status.text ? "on" : ""}${status.err ? " err" : ""}` },
				h("span", {}, status.text),
				busy ? h("button", { class: "sb", onclick: () => api.cancelLogin() }, "Cancel") : h("button", { class: "sb", onclick: () => setStatus("") }, "✕"),
			),
			h("div", { class: "sbody" }, readingSection(), modelSection(), webSection(), accountsSection(), behaviourSection(), dataSection()),
		);
		const body = root.querySelector(".sbody");
		body.scrollTop = keep;
		if (scrollTo) {
			root.querySelector(`#sec-${scrollTo}`)?.scrollIntoView();
			scrollTo = undefined;
		}
	}

	window.renderSettings = async (section) => {
		scrollTo = section;
		status = { text: "", err: false };
		await refresh();
	};
})();
