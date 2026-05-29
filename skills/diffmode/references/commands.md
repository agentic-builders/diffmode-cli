# Commands reference

Complete catalog of `diffmode` commands. Each entry lists: the backend
endpoint it calls, credit cost (where applicable), required + optional
flags, exit codes, and example invocations (TTY + `--json` forms). For a
machine-readable version of this table, run `diffmode commands --json`.

> **Drift policy.** The CLI emits its commander tree as a manifest; the
> test `test/commands-reference-drift.test.ts` asserts every command listed
> here also appears in `diffmode commands --json`. Don't add a new command
> without updating this file.

## Globals (apply to every command)

| Flag | Description |
| --- | --- |
| `--json` | Emit machine-readable JSON (forces JSON even on a TTY). |
| `--no-color` | Disable ANSI colors. |
| `--quiet` | Suppress stderr progress. |
| `--verbose` | Verbose stderr output. |
| `--yes` | Auto-confirm interactive prompts. |
| `--token <pat>` | PAT override (precedence: `--token` > `DIFFMODE_TOKEN` env > stored). |
| `--profile <name>` | Configuration profile (default `default`). |
| `--timeout <s>` | Per-HTTP-request timeout in seconds (default 60). |

`--idempotency-key <uuid>` is **subcommand-scoped** (on submit commands
only) and **not** a global flag.

## Auth

### `diffmode login`

- **Endpoint:** `GET /public/v1/access-tokens` (validates PAT)
- Reads a PAT from stdin or `--token`. Stores it via OS keyring (or 0600
  file fallback with a one-time stderr warning).
- **Exits:** 0, 1, 2, 3, 4, 9
- Examples:
  ```bash
  diffmode login --token dm_pat_…
  echo "$DIFFMODE_TOKEN" | diffmode login
  ```

### `diffmode logout`

- Clears stored credentials for the active profile. Idempotent.
- **Exits:** 0

### `diffmode whoami`

- **Endpoint:** `GET /public/v1/access-tokens`
- Verifies the active token; prints identity metadata.
- **Exits:** 0, 1, 3, 4, 9
- Example: `diffmode whoami --json`

## Submit (job-creating)

All submit commands accept `--idempotency-key <uuid>` (optional, no
auto-generation). The CLI does a pre-flight `GET /billing/balance` before
posting unless `--no-preflight` is set.

### `diffmode run <product>` (default, **0 credits via CLI**)

- **Endpoint:** `POST /public/v1/free-tier`
- **Required input:** `--input <file|->` or `--from-url <url>` (founder
  diagnostics; see `founder-input-schema.md`).
- **Flags:** `--input`, `--from-url`, `--save-input`, `--idempotency-key`,
  `--no-preflight`
- **Exits:** 0, 1, 2, 3, 4, 5, 7, 8, 9
- Examples:
  ```bash
  diffmode run myproduct --input founder.json --idempotency-key "$(uuidgen)"
  diffmode run myproduct --from-url https://example.com --json
  ```

### `diffmode workflow <product>` (**2 credits via CLI**)

- **Endpoint:** `POST /public/v1/workflow`
- Cold-start full plan. Power-user verb.
- **Flags:** identical surface to `run`.
- **Exits:** 0, 1, 2, 3, 4, 5, 7, 8, 9

### `diffmode unlock <product>` (**2 credits via CLI**)

- **Endpoint:** `POST /public/v1/products/{id}/unlock`
- Server reuses the founder input from the prior completed free-tier run;
  no `--input` accepted here. On 422 → CLI exits 2 with
  `Run \`diffmode run <p>\` first.`
- **Flags:** `--idempotency-key`, `--no-preflight`
- **Exits:** 0, 1, 2, 3, 4, 5, 7, 8, 9

### `diffmode idea-eval <product>` (**1 credit via CLI**)

- **Endpoint:** `POST /public/v1/idea-eval`
- **Required input:** `--ideas-file <path>` — JSON array of `IdeaInput`
  objects (see `idea-input-schema.md`). Not resumable.
- **Flags:** `--ideas-file`, `--intuition`, `--target-idea`,
  `--idempotency-key`, `--no-preflight`
- **Exits:** 0, 1, 2, 3, 4, 5, 7, 8, 9
- Example:
  ```bash
  diffmode idea-eval myproduct --ideas-file ideas.json \
    --intuition "founder-mode onboarding is the highest-leverage" \
    --json
  ```

### `diffmode smoke-test <product>` (**1 credit**)

- **Endpoint:** `POST /public/v1/smoke-test`
- Always pass `--input` (CLI does NOT rely on the server-side disk
  fallback used by local-CLI mode). Not resumable.
- **Flags:** `--input`, `--from-url`, `--save-input`, `--idempotency-key`,
  `--no-preflight`
- **Exits:** 0, 1, 2, 3, 4, 5, 7, 8, 9

## Jobs

### `diffmode jobs list`

- **Endpoint:** `GET /public/v1/jobs?limit=&cursor=&product_id=&status=`
- Keyset pagination (max `--limit 200`).
- **Flags:** `--product`, `--status`, `--limit`, `--cursor`
- **Exits:** 0, 1, 3, 4, 9
- Examples:
  ```bash
  diffmode jobs list --product myproduct --json
  diffmode jobs list --cursor "$NEXT_CURSOR"
  ```

### `diffmode jobs status <job_id>`

- **Endpoint:** `GET /public/v1/jobs/{job_id}`
- **Exits:** 0, 1, 3, 4, 6, 9

### `diffmode jobs watch <job_id>`

- Repeated `GET /public/v1/jobs/{job_id}`; honors `next_poll_ms` with
  ±20 % jitter clamped to `[3 s, 30 s]`.
- **Flags:** `--wait <duration>` (e.g. `4h`, `30m`, `300s`; this is the
  **total polling wait**, distinct from the global per-request
  `--timeout`). The deadline is enforced at the start of every poll
  iteration AND retry sleeps (429 `Retry-After`, transient backoff) are
  clamped to the remaining budget, so a single long `Retry-After` cannot
  push the watch past `--wait`.
- **Exits:** 0, 1, 3, 4, 6, 7, 9, 10, 130
- Persistent `429` responses (≥5 in a row) surface as exit 7 with code
  `rate_limited` and the server's `Retry-After` echoed in the envelope.
- `--wait` deadline exhaustion exits **1** with `code: "generic"` (the
  server-side job keeps running; re-watch to resume). This is distinct
  from exit 7 — the CLI has no `retry_after` to promise on a client-side
  timeout, so it deliberately does NOT pose as back-pressure.
- Ctrl-C: prints `Resume with: diffmode jobs watch <id>` to stderr; never
  calls `DELETE /jobs/{id}`.

### `diffmode jobs resume <job_id>`

- Two-step:
  1. `GET /public/v1/jobs/{job_id}` to fetch `module_type` + `product_id`.
  2. Branch:
     - `free-tier` → `POST /public/v1/free-tier/{product_id}/retry`
     - `workflow` → `POST /public/v1/workflow/resume`
     - other modules → exit 2 with "module is not resumable" hint.
- **Flags:** `--idempotency-key`
- **Exits:** 0, 1, 2, 3, 4, 6, 9

### `diffmode jobs cancel <job_id>`

- **Endpoint:** `DELETE /public/v1/jobs/{job_id}`
- Idempotent; on TTY prompts unless global `--yes` is set.
- **Exits:** 0, 1, 2, 3, 4, 6, 9
- Declining the interactive `y/N` confirmation exits 2 with code `usage`
  (no `DELETE` issued) — same envelope agents already handle for malformed
  flags, so the path is predictable from `diffmode commands --json`.

## Results

### `diffmode results <product>`

- Resolves the latest completed job (or `--job-id <id>`), downloads
  `/products/{id}/outputs`, and emits a manifest:
  ```json
  {
    "schema_version": "1",
    "product": "<p>",
    "job_id": "<id>",
    "module_type": "free-tier",
    "out_dir": ".diffmode/<p>/<id>/",
    "total_files": 14,
    "total_bytes_est": 184323,
    "report_sections": ["meta", "landscape", "advantages", "growthPlan", ...]
  }
  ```
- **Flags:** `--job-id`, `--out`, `--summary`, `--show <path>`,
  `--max-tokens <n>`, `--pull`, `--stage <s>`, `--tactic <t>`
- **Exits:** 0, 1, 2, 3, 4, 6, 9
- `--summary` returns `report.json` keyFinding sections for free-tier
  jobs; for workflow/unlock it prints a Phase-2 stub.
- **Phase-1 `--job-id` caveat:** `/products/{id}/outputs` returns the
  current product workspace; the API does not yet serve per-job artifact
  snapshots. `--job-id` pins the manifest's `job_id` field, but downloaded
  files always reflect the latest run. If the pinned job is not the latest
  completed run, the manifest JSON carries `latest_completed_job_id`
  (always emitted, not silenced by `--quiet`), the CLI redirects the local
  snapshot dir to `<latest-job>/` so any prior `<pinned>/` snapshot stays
  intact, and a stderr note describes the redirect for humans. If the
  advisory drift lookup itself fails (transient 429/5xx/network), the
  manifest sets `drift_lookup_failed: true` and the CLI warns on stderr
  that drift status could not be verified. Per-job snapshots ship with the
  Phase-2 manifest endpoint.

## Billing (read-only)

### `diffmode account`

- **Endpoint:** `GET /public/v1/billing/balance`
- Pretty table on TTY; full `CreditBalance` JSON on `--json`.
- **Exits:** 0, 1, 3, 4, 9

### `diffmode billing balance`

- Terse `{balance, has_purchased}` (or pretty on TTY).
- **Exits:** 0, 1, 3, 4, 9

### `diffmode billing history`

- **Endpoint:** `GET /public/v1/billing/history?limit=&offset=`
- **Offset-based** pagination (not B5 keyset). NDJSON output on non-TTY.
- **Flags:** `--limit`, `--offset`
- **Exits:** 0, 1, 3, 4, 9

### `diffmode limits`

- Derives credit availability from `/billing/balance`, and reports the
  rate-limit policy the server returns there (`rate_limit_max` /
  `rate_limit_window_h`). `null` means no cap — exempt accounts (purchased
  or operator-allowlisted). When the server omits the fields (older
  backend), falls back to the documented `3` submissions / `24` h default.
- **Exits:** 0, 1, 3, 4, 9
- Does NOT estimate `free_submits_remaining` — the backend doesn't expose
  remaining slots and a CLI-local guess would lie across devices.

### NO `diffmode billing topup`

Top-up is **browser-only by design**. On exit 8 from any submit, the CLI
prints `Insufficient credits. Top up at <DIFFMODE_BILLING_URL or default>`
and exits. Override the redirect with `DIFFMODE_BILLING_URL`.

## Diagnostics helpers

### `diffmode diagnostics from-url <url>`

- **Endpoint:** `POST /public/v1/analyze-website`
- Prints a draft `FounderDiagnostics` JSON; `--save <path>` writes to
  disk instead.
- **Exits:** 0, 1, 2, 3, 4, 9

### `diffmode diagnostics validate <path>`

- Validates a founder-input JSON file against the documented schema. Exits
  0 if valid, 2 with field-level errors otherwise.
- **Exits:** 0, 1, 2

## Self-describing

### `diffmode commands`

- Emits the full commander tree as a manifest. Always JSON (no `--json`
  required). Stable schema; use it for agent discovery.
- **Exits:** 0

### `diffmode --version --json`

- Emits `{schema_version, version, node, platform}`. Plain text without
  `--json`.

## Agent integration

### `diffmode skill show`

- Prints the bundled `SKILL.md` to stdout (`{path, contents}` on `--json`).
  Useful for agents that want to inspect the skill without installing it.
- **Exits:** 0, 1

### `diffmode skill install`

- Copies the bundled skill into per-tool agent dirs.
- **Flags:**
  - `--target <claude|codex|cursor|all>` (default `all`)
  - `--yes` overwrites a divergent existing file (without it, the command
    reports `needs-confirm` and writes nothing)
  - `--dry-run` reports the action without writing
  - `--print-paths` prints the resolved target paths and exits
- **Default paths** (override with `DIFFMODE_SKILL_{CLAUDE,CODEX,CURSOR}_PATH`):
  - Claude: `~/.claude/skills/diffmode/SKILL.md`
  - Codex: `~/.codex/skills/diffmode/SKILL.md`
  - Cursor: `~/.cursor/rules/diffmode.mdc`
- Skips a target gracefully when the parent tool's home dir is missing
  (e.g., Claude Code not installed) — non-fatal.
- **Exits:** 0, 1, 2

### `diffmode skill uninstall`

- Removes the bundled skill files written by `skill install`.
- **Flags:**
  - `--target <claude|codex|cursor|all>` (default `all`)
  - `--yes` removes a file whose on-disk content differs from the
    bundled source (e.g., user-edited). Without it, the command reports
    `needs-confirm` and writes nothing.
  - `--dry-run` reports the action without writing
  - `--print-paths` prints the resolved target paths and exits
- **Actions emitted per target:**
  - `removed` — file existed and was deleted
  - `not-installed` — no file at the destination; no-op
  - `needs-confirm` — file differs from bundled; re-run with `--yes`
  - `would-remove` — `--dry-run` previewed a removal
- **Empty-parent cleanup:** for claude/codex targets, the
  `~/.<tool>/skills/diffmode/` directory is removed if empty after the
  file delete. Cursor's `~/.cursor/rules/` directory is never removed
  (belongs to Cursor).
- **Exits:** 0, 1, 2
