# Changelog

All notable changes to the `diffmode` CLI are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-05-22

### Added

- **CHANGELOG.md** - Bootstrap the changelog so future releases have a record of user-facing changes by @ivan-magda in https://github.com/agentic-builders/diffmode-cli/releases/tag/v0.1.1
  - First release published via the new tag-driven GitHub Actions workflow (`.github/workflows/publish.yml`)
  - npm provenance attestation enabled (OIDC token signed by the workflow run, verifiable on the package page)

## [0.1.0] - 2026-05-22

Initial public release. Agent-drivable thin HTTP client over the Diffmode `/public/v1/*` API. Imported from the source monorepo as commit [`47c1430`](https://github.com/agentic-builders/diffmode-cli/commit/47c1430) by @ivan-magda.

### Added

- **Authentication commands** - `login`, `logout`, `whoami`. Reads PAT from stdin or `--token`. Stores credentials via OS keyring with mode-0600 file fallback.
- **Submit commands** - `run` (free-tier, 1 credit, default verb), `workflow` (15), `unlock` (15), `idea-eval` (5), `smoke-test` (1). All accept `--input <file|->`, `--from-url <url>` (pre-fill via `/analyze-website`), and optional `--idempotency-key <uuid>`.
- **Job lifecycle** - `jobs list`, `status`, `watch` (adaptive backoff via server `next_poll_ms`; NDJSON progress on stderr in non-TTY), `resume` (module-branched: workflow + free-tier resumable), `cancel`. Ctrl-C during `watch` never cancels the server job.
- **Results** - `results <product>` produces a manifest JSON with `--summary`, `--stage`, `--tactic`, `--show <path>`, `--pull`, `--max-tokens`, `--out <dir>`. Phase 1 reads the free-tier `report.json` + raw `/outputs`.
- **Account + billing** - `account`, `billing balance`, `billing history`, `limits`. Read-only by design; top-up is browser-only via `DIFFMODE_BILLING_URL` (defaults to `https://diffmode.app/app/billing`).
- **Founder input** - `diagnostics from-url <url>` pre-fills `FounderDiagnostics` via the hosted `/analyze-website` endpoint; `diagnostics validate <path>` validates a founder-input JSON file against the schema.
- **Agent companions** - `skill show` prints the bundled `SKILL.md`; `skill install [--target claude|codex|cursor|all]` copies it into known agent paths. SKILL.md, AGENTS.md, Cursor MDC rule, and llms.txt all generated from a single source via `scripts/sync-companions.ts`.
- **Self-describing manifest** - `diffmode commands` emits the full command tree as JSON (24 leaf commands, all flags and exit codes) for agent self-discovery.
- **Output contract** - Schema-versioned JSON envelope (`schema_version: "1"`) on non-TTY/`--json`; markdown + tables for TTY; NDJSON for lists. Structured `{error: {code, message, retryable, retry_after, docs_url}}` on stderr.
- **Exit codes** (spec §8) - `0` ok · `1` generic · `2` usage · `3` network · `4` auth · `5` conflict · `6` not-found · `7` rate-limited · `8` insufficient-credits · `9` server · `10` interrupted-resumable · `130` SIGINT.

### Technical

- TypeScript strict mode, Node ≥ 20.
- Bundled with esbuild to a single 222.9 kB CJS bin at `dist/bin.js` (native `keytar` excluded via `--external`).
- 339 tests passing (`vitest` + `msw` for HTTP mocks).
- Apache-2.0 licensed; first published as `diffmode` on npmjs.com under the `agentic-builders` org.

## Version History

- **v0.1.1** (2026-05-22) - Bootstrap CHANGELOG.md; first release via the CI publish workflow with npm provenance
- **v0.1.0** (2026-05-22) - Initial public release: full Phase 1 surface (auth, submit, jobs, results, billing, agent companions, self-describing manifest)
