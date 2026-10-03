# ADR 0001 · One production runtime: Pi coding-agent SDK plus a Midnight journal

Status: accepted · 2026-10-04 · plan chapters 03, 24 (F03, F04)

## Context

The rework plan asks for a timeboxed gate between experimental Pi Durable and the coding-agent SDK, then one
production runtime behind `MidnightRuntimeAdapter`. The spike scripts live in `docs/spikes/runtime-gate/` and run
against the published 1.0.1 packages with pi-ai's `faux` provider, so they are reproducible without accounts.

## Evidence (all measured on this machine, Windows 10 x64, 2026-10-04)

| Gate | Durable 1.0.1 | SDK 1.0.1 |
|---|---|---|
| Runtime packaging | `node:sqlite` 3.53.4 available in Electron 44.4.5 (Node 24.21.0, meets `>=22.19.0`); harness opened in 42 ms | Same Node; session created in 12 ms |
| Action interception | `beforeTool` hook blocks (`durable.mjs`) | Inline extension `tool_call` blocks a direct call **and** a nested `ctx.executeTool` call (`gate.mjs`: only the permitted effect happened) |
| Recovery semantics | Unsafe tool killed mid-call returns `interrupted … may have partially run`; `requestId` dedups the submission | Session JSONL reopens with all 5 messages (`sdk.mjs`); tool replay is Midnight's decision |
| Duplicate effects | **After resume the model re-issued the same send and it ran again (2 effects)** | Same risk; nothing in either runtime prevents it |
| Event completeness | `watchEvents` is marked experimental | `agent_start … agent_settled` stream observed |
| MCP compatibility | Coding-agent MCP / Codemode / tool-search factories are not documented for Durable | `createMcpExtension`, `createCodemodeExtension`, `createToolSearchExtension` exported; Codemode calls still pass `tool_call` |
| Maintainability | README: "The API changes without notice between releases" | Stable SDK, small surface used |

## Decision

Use the **coding-agent SDK 1.0.1** with one persistent `SessionManager` session per mission, and a Midnight-owned SQLite
mission/action journal (`src/storage`, `src/policy/ledger.mjs`). This is the plan's documented fallback, chosen because
the MCP-compatibility and maintainability gates fail for Durable today, and because the duplicate-effect result shows the
journal is required with either runtime. Durable remains a candidate: the adapter conformance tests in
`test/runtime-adapter.test.mjs` are the gate to re-run when its API stabilizes.

Rules that follow from the evidence:

- Every tool call, direct or nested, passes the broker through the inline `tool_call` gate (`src/runtime/broker-extension.mjs`).
- A mission succeeds only when Midnight's checks pass. `agent_settled` means "Pi will not continue", nothing more.
- An intent whose dispatch outcome is unknown is never re-dispatched because the model asked again; it is reconciled.
- Ambient discovery is off (`noExtensions`, `noSkills`, `noContextFiles`): Midnight loads only bundled, reviewed code.

## Consequences

Midnight owns checkpointing of mission state, receipts and approvals; Pi owns conversation context and compaction. The
fallback costs a journal we would need anyway. Two production engines are not maintained.
