# midnight.app

The midnight.server desktop capsule: a small pill above your taskbar that searches, reads and works in plain view, and asks before anything leaves your computer. It runs on the AI subscription or API key you sign in with (ChatGPT, Claude, Copilot, …) through the [midnight.server](https://github.com/soliluqoy/midnight.server) core.

## Install

**Windows (x64)**, in PowerShell (per-user, no admin):

```powershell
irm https://raw.githubusercontent.com/soliluqoy/midnight.app/main/install.ps1 | iex
```

**macOS (Apple silicon) / Linux (x86_64)**, in a terminal:

```sh
curl -fsSL https://raw.githubusercontent.com/soliluqoy/midnight.app/main/install.sh | sh
```

Then press `Ctrl+Alt+M` (`Cmd+Alt+M` on macOS) and sign in from the gear icon. Running the installer again updates the app. To uninstall, run `install.ps1 -Uninstall` or `install.sh --uninstall` (the exact commands are at the top of each script). Downloads come from the [latest release](https://github.com/soliluqoy/midnight.app/releases/latest). Builds are unsigned, and desktop control (computer use) is Windows-only for now.

## Develop

    npm install
    npm start

The core packages are vendored as tarballs in `vendor/`. After changing `../midnight.server`, build it and run `npm run vendor && npm install`. `npm run dist` builds a package for the current OS into `release/`. Pushing a `v*` tag builds Windows, macOS arm64 and Linux on GitHub Actions and publishes a release.

## Features

- **Capsule:** resting pill → `Ctrl+Alt+M` → ask box → mission card (steps, live log, approvals, streaming answer, receipts). Tray icon to quit.
- **Answers:** stream in live as Markdown (lists, tables, code) with clickable `[n]` citations tied to a Sources list. Finished answers take the whole card; `≡` brings back the log. Ask follow-ups in the same thread; *Copy* (`Ctrl+Shift+C`) copies the Markdown; `1`–`9` open a source; `Ctrl+L` starts over.
- **Reading:** text size S…3X (`Ctrl +` / `Ctrl −` / `Ctrl 0`, or Settings) scales the whole capsule and it stays on screen; `⤢` / `Ctrl+E` opens a wide reading view (automatic for long answers); high-contrast mode; answer length brief / normal / detailed.
- **Web, fast:** `search` returns results as text (Google, falling back to Bing / DuckDuckGo when blocked; several queries in parallel) and `read_pages` reads up to 8 pages at once in a pool of hidden windows, main content only, trimmed to the passages matching the question. Images, media, fonts and trackers are blocked there, and pages/results are cached for 30 minutes. Prefix `?` for a quick answer, `??` for deep research. When you open the ask box with a link or long text on the clipboard, a chip offers to summarize it.
- **Plan first, for actions:** questions and research just run. Tasks that act call `plan`; nothing runs until you press *Approve plan* (read-only plans can run without the click; Settings). Steps that send/post/delete are tagged "asks first".
- **Asks before it leaves:** the model calls `ask` before any outward or irreversible action and blocks until you answer.
- **In plain view:** every read/action lands in the log. During computer use a purple cursor and dashed frame show where it's looking (click-through overlay, hidden from its own screenshots).
- **Esc takes over:** while a mission runs, Esc aborts it and switches computer use off.
- **Web engine:** a hidden background Chromium window (persistent logins) for pages that need clicking or typing; the ◫ button in a mission shows it. Reading and search use a separate partition (`persist:midnight-research`).
- **Computer use:** `computer` tool, only usable after approving a plan that says it uses the screen.
  - *Accurate:* `elements` lists a window's controls from Windows UI Automation (ids, names, values, exact centres) and `click_element` / `set_value` act by id. `read_text` returns the exact text of an app or browser tab without a screenshot. `zoom` shows a region at full resolution.
  - *Apps:* `windows`, `focus_window` and `launch` (it waits for the new window and focuses it).
  - *Safe:* keystrokes only go to the window it's working in, never the capsule. If focus moved, it refocuses once, otherwise it refuses and types nothing.
  - *Fast:* shorter pauses, screenshots captured at model size, and `screenshot:false` for chaining steps. Elevated (admin) windows don't expose controls, so it falls back to screenshots.
- **Choosing a browser:** background `search` / `read_pages` for public info; midnight's own `browser` for sites it's signed in to or that need no account (`browser` `session` checks); the user's own default browser (`user_browser`: status, the page they're on, open pages there) when they mean "this page", when a site needs their signed-in session (driven by computer use), or to show them a page. When the capsule is summoned it notes the window you came from (and its URL if it's a browser) and adds that to the prompt (Settings → *Know where I was*).
- **Settings** (⚙ in the capsule, tray → Settings…): model and thinking level (models from every provider you're signed in to, vision flagged); accounts (sign in with ChatGPT/Claude/Copilot/xAI/…, or add an API key, sign out, search all providers); computer use (ask in plan / never); summon shortcut; capsule corner; start with Windows (installed build only); standing instructions; clear browser data; open data folder. Stored in the app's data folder (`%APPDATA%\midnight` when installed, `%APPDATA%\midnight-app` in development).
- **Auth:** shares `~/.midnight.server/agent/auth.json` with the CLI, so a login in either shows up in both.
- **Core:** `@earendil-works/pi-coding-agent` / `pi-ai` and their siblings from midnight.server, vendored in `vendor/` (see *Develop*).
- **Headless check:** `MIDNIGHT_SELFTEST="prompt" npm start` runs one prompt with plans auto-approved (`MIDNIGHT_SELFTEST_ASK=no` declines asks).

Not built: voice/narration, connectors (Drive, Mail, CRM, charts), multiple concurrent missions.
