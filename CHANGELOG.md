# Changelog

All notable changes to the `diffmode` CLI are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.3] - 2026-05-26

### Added

- **`user_id` in identity command output** — `diffmode whoami`, `diffmode login`, and `diffmode account` now include the authenticated user's full 32-char hex UUID in their JSON envelopes by @ivan-magda in https://github.com/agentic-builders/diffmode-cli/pull/1. Closes the gap where CLI output showed only `current_token_prefix` (e.g. `dm_pat_YwSRl`) and couldn't answer "whose account is this?" without a second tool. Additive on `schema_version: "1"`; old clients ignore the new field. Requires backend with [hyperskill/ai-cmo#315](https://github.com/hyperskill/ai-cmo/pull/315) deployed.

## [0.1.2] - 2026-05-22

### Fixed

- **`diffmode --version` printed `0.1.0` in v0.1.1** by @ivan-magda in https://github.com/agentic-builders/diffmode-cli/releases/tag/v0.1.2 — `VERSION` was hardcoded in `src/bin.ts`, but `npm version <bump>` only updates `package.json` and `package-lock.json`, so the two drifted on every release. Now `VERSION` is imported from `package.json` and esbuild inlines the current value into the bundle at build time. Single source of truth; this drift class is structurally impossible going forward.

### Added

- **Regression test for version sync** — `test/acceptance.test.ts` rebuilds and asserts `dist/bin.js --version` matches `package.json#version`. Catches the bug above if a hardcoded constant is ever reintroduced.
- **`verify` script** — canonical `lint + typecheck + build + test` chain. Both `preversion` and `prepublishOnly` delegate to it (DRY).
- **`preversion` lifecycle hook** — runs `verify` before `npm version` writes the tag. Drift now fails locally before the tag exists on GitHub (vs. failing at publish time after the tag is already pushed).
- **`scripts/release.sh`** (invoked via `npm run release <patch|minor|major>`) — wraps `npm version` + `git push --follow-tags` with safety guards: refuses if not on `main`, working tree is dirty, origin is ahead, or `CHANGELOG.md` is missing an entry for the next version.

### Changed

- `prepublishOnly` simplified to `npm run verify` (was inline `lint && typecheck && test && build`); order is now `build` before `test` so the version-sync regression test runs against a fresh bundle.

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

- **v0.1.3** (2026-05-26) - Add `user_id` (full 32-char hex UUID) to `whoami`, `login`, and `account` JSON output; requires backend support shipped in hyperskill/ai-cmo#315
- **v0.1.2** (2026-05-22) - Fix `--version` drift (single source of truth from `package.json`); add `preversion` hook + `release.sh` + regression test so the bug class can't recur
- **v0.1.1** (2026-05-22) - Bootstrap CHANGELOG.md; first release via the CI publish workflow with npm provenance
- **v0.1.0** (2026-05-22) - Initial public release: full Phase 1 surface (auth, submit, jobs, results, billing, agent companions, self-describing manifest)
