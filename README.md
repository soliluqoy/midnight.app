# midnight.app

A quiet desktop capsule that researches, creates files and works on your computer in plain view. Missions keep their plans, activity, approvals, evidence and results together, so you can follow up or resume unfinished work.

Midnight uses the [midnight.server](https://github.com/soliluqoy/midnight.server) core with your supported AI subscription or API key, or a local model through an Ollama-compatible endpoint.

## Install

**Windows (x64)**: download `midnight-setup-x64.exe` from the [latest release](https://github.com/soliluqoy/midnight.app/releases/latest), or run this in PowerShell for a per-user installation without admin rights:

```powershell
irm https://raw.githubusercontent.com/soliluqoy/midnight.app/main/install.ps1 | iex
```

**macOS (Apple silicon) / Linux (x86_64)**:

```sh
curl -fsSL https://raw.githubusercontent.com/soliluqoy/midnight.app/main/install.sh | sh
```

Desktop control is Windows-only. Search, reading and Midnight's background browser are available on all three platforms. Builds without signing credentials are unsigned; the macOS installer applies an ad hoc signature.

### First run

1. Press `Ctrl+Alt+M` (`Cmd+Alt+M` on macOS) to summon the capsule.
2. Open Settings from the gear icon. Sign in to a supported provider, add an API key, or configure a local model.
3. In **Sources**, select folders Midnight may read and output folders where it may save drafts.
4. Ask a question or give it a task. Prefix a prompt with `?` for a quick answer or `??` for deep research.

Use **All missions** to return to earlier work. Right-click the capsule and choose **Hide capsule**, or press `Ctrl+H` while it is focused (`Cmd+H` on macOS). Work continues while hidden; the summon shortcut or tray icon brings it back. Quit from the tray menu.

### Updates and uninstall

Running the installer again updates the app. Settings also offers update checks and notifications. In-app installation requires an idle app and a Windows installer that passes checksum and signature verification; unsigned installers are not run, and the release page opens instead.

To remove a script installation on Windows:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/soliluqoy/midnight.app/main/install.ps1))) -Uninstall
```

On macOS or Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/soliluqoy/midnight.app/main/install.sh | sh -s -- --uninstall
```

For a Windows setup installation, use Windows' installed-apps settings. Uninstalling preserves app data and shared provider sign-ins.

## Working with Midnight

- **Mission dashboard:** switch between missions, inspect plans and live activity, answer questions, review approvals, pause and resume work, and follow up in the same thread. Outcome checks, evidence and action receipts distinguish completed work from partial or uncertain results.
- **Research and answers:** streamed Markdown with tables, code and numbered sources; parallel searches and page reads; clipboard suggestions for links or long text; a wide reading view, adjustable text size, high contrast and reduced motion.
- **Files and documents:** read selected folders and CSV/XLSX ranges, calculate with recorded formulas, create SVG bar charts with CSV data, write DOCX or Markdown reports, and prepare `.eml` email drafts. Generated artifacts carry validation results and source references.
- **Browsing:** public research uses background search and page-reading tools. Interactive sites use Midnight's own browser with persistent logins. Tasks that need your existing browser session can use Windows desktop control after approval.
- **Desktop control:** Windows UI Automation exposes controls and text for precise interaction; screenshots and zoom support visual tasks. A purple cursor and frame show where Midnight is working. Only one mission can control the screen at a time. **Esc takes over and revokes desktop control**; mission cards also offer Pause and Resume.
- **Routines, watches and memory:** save a mission as a reusable routine, review it and run it again. Watches check pages, folders or connected accounts on a schedule without a model call for the check; changes enter an attention queue with quiet hours. Review, edit, confirm or delete remembered preferences in Settings.
- **Resource controls:** Quiet, Balanced, Focused and Burst profiles govern background work. Missions have cost and tool-call budgets, and background work can wait for power or connectivity.

### Approvals and autonomy

Questions and research can run directly. File-producing and action tasks record a plan with outcome checks. A plan that needs desktop control requires approval before accessing the screen; other plans proceed to the individual action checks.

Every tool call passes through Midnight's policy broker. Approval cards show the proposed action and relevant details, such as recipients, attachments or a preview. Authority comes from your selected folders, autonomy mode, rules and approvals.

| Mode | Behavior |
| --- | --- |
| **Ask me** | Reads approved sources and prepares artifacts in its workspace; asks before other changes unless a rule covers them. |
| **Prepare for me** | Also saves and moves drafts within selected output folders; sending or posting still requires approval unless a rule covers it. |
| **Act within my rules** | Uses rules you created for covered actions and allows watches to prepare work; other actions still ask. |

Approving a desktop plan does not authorize every later action. Changed action details require fresh authorization. When an action may have completed before an interruption, Midnight records that uncertainty and reconciles it before retrying.

### Models and privacy

Settings lets you choose a model and thinking level, plus a task model for plans, desktop work and research. Provider credentials are shared with the midnight.server CLI through `~/.midnight.server/agent/auth.json`.

| Privacy mode | Behavior |
| --- | --- |
| **Cloud model** | Your request and the content Midnight reads for the task go to the chosen model provider. |
| **Local only** | Uses the configured local model without cloud fallback; public web tools may still access the network. |
| **Offline** | Uses the local model and local files; mission network tools are unavailable. |

Missions, settings, evidence, drafts and memory are stored in the app's data folder. On Windows this is `%APPDATA%\midnight` when installed and `%APPDATA%\midnight-app` in development. Open the folder from **Settings → Data**. That section also offers JSON export, history and memory deletion, browser-data clearing and a support-bundle preview. Deleting finished mission content retains records of actions that left the computer.

### Keyboard shortcuts

Use `Cmd` in place of `Ctrl` on macOS.

| Shortcut | Action |
| --- | --- |
| `Ctrl+Alt+M` | Summon the capsule; configurable in Settings |
| `Ctrl+H` | Hide the focused capsule while work continues |
| `Esc` | Take over desktop control while work is active |
| `Ctrl+E` | Toggle the mission's wide reading view |
| `Ctrl+Shift+C` | Copy the answer as Markdown |
| `Ctrl+L` | Start a new task from an idle mission or the mission list |
| `Ctrl++` / `Ctrl+-` / `Ctrl+0` | Increase, decrease or reset text size |
| `1`–`9` | Open a numbered source when not typing |
| `↑` | Recall the last prompt in the ask box |

## Current limits

- CRM and mail connectors are demo fixtures; they do not connect real accounts or send real mail. Local email drafts work without a connector.
- PDF text extraction, OCR and PowerPoint output are not implemented.
- Arbitrary MCP servers and Codemode integration are not yet wired into the app.
- Voice and narration are not implemented.
- Visual regression baselines are machine-specific; CI checks that the views render without errors.

## Develop

Use Node.js 24 (the version used in CI) and npm:

```sh
npm ci
npm start
```

Core packages are vendored as tarballs in `vendor/`. After changing `../midnight.server`, build that repository, then run these commands here:

```sh
npm run vendor
npm install
```

The Electron shell lives in `src/main.mjs` and `src/desktop/`; the mission engine runs in a separate utility process. `src/missions/`, `src/policy/` and `src/storage/` own mission state, authorization and the SQLite journal. Tools live in `src/tools/`, with scheduling, memory and bundled skills in their respective directories.

| Command | Purpose |
| --- | --- |
| `npm test` | Unit, backend, end-to-end, adversarial and architecture checks |
| `npm run test:ui` | Dashboard interactions, async races and keyboard navigation |
| `npm run test:smoke` | Real Electron startup, engine readiness and capsule rendering |
| `npm run test:visual` | Capsule states and screenshot regression checks |
| `npm run dist` | Build a package for the current OS into `release/` |
| `npm run sbom` | Generate a software bill of materials |

For a one-prompt app check, set `MIDNIGHT_SELFTEST` before `npm start`. This mode automatically approves action requests; set `MIDNIGHT_SELFTEST_ASK=no` to decline them instead.

Pushing a `v*` tag runs checks, builds Windows x64, macOS arm64 and Linux x64 packages, and publishes a GitHub release. Pull requests run checks without packaging. Release signing uses the repository's Windows signing secrets when configured.

See [runtime decisions](docs/adr/0001-runtime.md), [dependency provenance](docs/adr/0002-dependencies.md) and [performance notes](docs/performance.md) for implementation details.
