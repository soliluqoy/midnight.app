# Autonomous rework · status and continuation plan

Plan: `Midnight autonomous rework plan.pdf` (backlog IDs from ch. 21). Updated 2026-10-04. Committed on branch `rework/mission-engine` (not pushed).

## Where it stands

The mission engine is built and wired into the app. `npm start` now runs it; the 0.1 engine remains behind
`engine: "legacy"` in Settings → Data (or `MIDNIGHT_ENGINE=legacy`).

Verification: `npm test` 50/50 (unit, real-Pi end-to-end with the faux model, crash recovery, adversarial,
architecture/provenance guards) · `npm run test:smoke` (real Electron, engine in its utility process, 0 renderer errors)
· `npm run test:visual` (11 capsule states vs baselines) · idle trace in `docs/performance.md`.

| Area | Done | Key files |
|---|---|---|
| F01–F04 baseline, spike, ADRs, pins, SBOM | ✓ | `docs/adr/`, `docs/spikes/`, `vendor/PROVENANCE.json`, `scripts/sbom.mjs` |
| F02 visual contract | ✓ | `scripts/visual.mjs`, `test/visual/` |
| R01–R06 contracts, host process, journal, storage, plans/checks | ✓ | `src/contracts`, `src/runtime/host*.mjs`, `src/desktop/supervisor.mjs`, `src/storage`, `src/missions` |
| P01–P05 grants, broker, ledger, stop scopes, vault, redaction | ✓ | `src/policy` |
| T01–T06 files, sheets, calculate, chart/report, CRM/mail (demo), evidence | ✓ | `src/tools`, `src/connectors`, `src/evidence` |
| U01–U05 truthful UI, decision/receipt/recovery cards, onboarding, stack, a11y basics | ✓ (audit pending) | `src/ui` |
| G01–G03 budgets, lazy/idle, power profiles | ✓ | `src/resources` |
| C01–C03, B01, W01 queue, screen lease + helper fencing, locks, per-mission browser, MTA helper | ✓ | `src/windows/lease.mjs`, `src/tools/input-helper.ps1`, `src/desktop/browsers.mjs` |
| S01–S04 recurrence (DST), watches, rules editor, attention/quiet hours | ✓ | `src/scheduler` |
| M01 model routing, local endpoint, no cloud fallback | ✓ | `src/runtime/models.mjs` |
| K01–K02 memory, skill packs, recipes | ✓ | `src/memory`, `src/skills` |
| Q01 adversarial corpus · Q02 holdout (51 scenarios, runner, headless web) · Q03 idle trace | ✓ / runner not yet run / partial | `test/adversarial.test.mjs`, `evals/`, `src/tools/web-headless.mjs` |
| D01–D03 NSIS + updater (verify sha512 + signature), export/delete, diagnostics | ✓ code; signing needs a certificate | `src/desktop/updater.mjs`, `src/storage/data.mjs` |

## Continuation plan (in order)

1. **You, once:** open the app (`npm start`), check Settings → Accounts shows your providers signed in (credentials
   are read from `~/.midnight.server/agent`), run one real question and one task, and look at the capsule.
2. ~~Commit on a branch~~ done: four slices on `rework/mission-engine` plus follow-ups. `AGENTS.md`, `reports/`,
   `research_notes/` stay untracked.
3. **Real-model evaluation:** `node evals/run.mjs --model <provider/id> --repeat 3`; fix prompts/tools until the
   predeclared threshold holds with zero critical violations. Record results under `evals/results/`.
4. ~~Headless web in evals~~ done: `src/tools/web-headless.mjs` (plain fetch; DuckDuckGo then Bing result pages,
   regex article extraction in `src/tools/web-text.mjs`) backs `tool.search`, `tool.read_pages` and `fetch.page` in
   the runner. `--no-web` turns it off. Script-rendered pages come back short; browser and desktop scenarios still
   report what they could not do.
5. **First real connectors (decision needed):** pick one CRM and one mail provider used by real users (plan ch. 24);
   implement against `src/connectors/registry.mjs` with OAuth via the vault; keep the demo connectors for failure tests.
6. **MCP/Codemode:** wire `createMcpExtension` behind the broker gate with reviewed-server pinning and tool-schema
   digests (unreviewed tools already require approval).
7. **Measurements still missing:** model task, browser task, desktop task, 24 h watch soak, battery drain, 100-mission
   leak slope (extend `MIDNIGHT_PERF`).
8. **Accessibility audit:** screen reader pass, 100–200% DPI, multi-monitor, high contrast on the new cards.
9. **Release engineering:** code-signing certificate in CI secrets, staged rollout, runbooks in `docs/runbooks/`
   (stop all input, disable writes, revoke, restore backup, support bundle, uninstall with data choice).
10. **Retire legacy** after a support window: delete `src/legacy/`.
11. **P2/P3** (morning runway, promise board, show-me, voice, night gardener) only after the beta gates pass.

## Known limits (be honest about these)

- Demo CRM/mail are fixtures; no real account is connected yet. Real sends need step 5.
- OCR and PDF text extraction are not implemented; PPTX output is not implemented.
- Pixel baselines are machine-specific; CI only checks that every state renders without errors.
- Updates install only signed builds; current CI builds are unsigned, so the updater opens the release page instead.
