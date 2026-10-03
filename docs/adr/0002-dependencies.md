# ADR 0002 · Exact upstream Pi 1.0.1, vendored with provenance

Status: accepted · 2026-10-04 · plan chapters 02, 03, 19 (F01, F04)

## Context

Before this change `vendor/` held six Pi-family tarballs packed from the `../midnight.server` fork at 0.99.1, while
`pi-mcp` and `pi-codemode` 0.99.1 resolved from the public registry. A fork build and an upstream build of the same
version therefore coexisted in one install, which the plan forbids. Pi 1.0.0 shipped on 1 October; 1.0.1 is now `latest`.

Patch audit of the fork against what the app uses (`createAgentSession`, `createExtensionRuntime`, `ModelRuntime`,
`SessionManager`, `SettingsManager`):

| Fork change | Used by the app? | Decision |
|---|---|---|
| `piConfig` rename to `midnight.server` / `.midnight.server` | Only as the credential location | Keep the location explicitly (`authPath`), not via the package |
| `dist/harness/*` (checks, checkpoints, contracts, drift) | No | Replaced by Midnight's mission checks |
| `dist/midnight/*` (local engine manager, downloads, pins) | No | Replaced by the user-installed local endpoint path (plan ch. 10) |
| Fact guard, certified project data, strict MCP | No | Midnight's broker owns policy |
| TUI and branding changes | No | Not shipped in the desktop app |

## Decision

- Depend on **upstream 1.0.1** for all eight Pi-family packages the SDK needs (`chord`, `pi-telemetry`, `pi-ai`,
  `pi-agent-core`, `pi-tui`, `pi-coding-agent`, `pi-mcp`, `pi-codemode`). `npm run vendor:upstream` packs them from the
  registry into `vendor/`, checks each tarball's SHA-512 against the registry's published integrity, and writes
  `vendor/PROVENANCE.json`.
- `npm run vendor` still packs from `../midnight.server` (the repository rule is unchanged) and now packs all eight, so
  a fork build is never mixed with upstream packages. `test/provenance.test.mjs` fails if installed versions or sources
  disagree with `PROVENANCE.json`.
- Credentials stay in `~/.midnight.server/agent/auth.json`, passed explicitly as `authPath`, so existing sign-ins and the
  sharing with the midnight.server CLI are preserved. Override with `MIDNIGHT_CORE_DIR`.
- `npm run sbom` writes `release/sbom.json` (name, version, integrity, license for every installed package).

## Verification and residual risk

The spike read a copy of the existing credential file with upstream 1.0.1 and listed 27 available models. A deeper
credential check was not run. After upgrading, open Settings → Accounts once and confirm your providers show as signed in.
