# diffmode

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node ≥ 20](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](package.json)
[![npm version](https://img.shields.io/npm/v/diffmode.svg)](https://www.npmjs.com/package/diffmode)

Agent-drivable CLI for the [Diffmode](https://diffmode.app) growth pipeline.
Thin wrapper around the hosted `/public/v1/*` API: authenticate, submit a
run, watch a job, retrieve manifest-shaped results.

## Tell your agent

> Use the diffmode CLI to generate a growth plan for my product.

Most LLM agents (Claude Code, Codex, Cursor) understand that sentence after
you install the bundled skill (see *Agent integration* below). For one-off
use, you can also run `diffmode` directly without an agent — it's a plain
CLI.

## Quick start

```bash
# 1. Authenticate (paste a PAT from https://diffmode.app/app/tokens)
npx diffmode@latest login --token dm_pat_…

# 2. Run the free-tier diagnostic (1 credit) for your product
diffmode run my-product --input founder.json

# 3. Watch the job until terminal
diffmode jobs watch <job_id>

# 4. Download outputs + emit a manifest
diffmode results my-product

# 5. Optionally unlock the full plan (15 credits)
diffmode unlock my-product
```

Top-up is **browser-only by design** — `diffmode` never prompts for a card
or invokes Stripe. When you run out of credits, the CLI exits with code 8
and a message pointing to `https://diffmode.app/app/billing`.

## Install

```bash
# Primary path — no install, always latest
npx diffmode@latest <command>

# Global install (power users)
npm i -g diffmode
```

Requires Node ≥ 20.

## Commands overview

| Command | What it does | Credits |
| --- | --- | --- |
| `diffmode login` / `logout` / `whoami` | PAT-based authentication | — |
| `diffmode run <product>` | Free-tier diagnostic | 1 |
| `diffmode unlock <product>` | Full plan (needs prior `run`) | 15 |
| `diffmode workflow <product>` | Cold-start full workflow | 15 |
| `diffmode idea-eval <product>` | Score ideas vs. founder context | 5 |
| `diffmode smoke-test <product>` | Quick tactic smoke-test | 1 |
| `diffmode jobs list/status/watch/resume/cancel` | Job lifecycle | — |
| `diffmode results <product>` | Download + manifest | — |
| `diffmode account` / `billing balance` / `history` | Read-only billing | — |
| `diffmode limits` | Credits + rate-limit policy | — |
| `diffmode diagnostics from-url/validate` | Founder-input helpers | — |
| `diffmode skill show` / `skill install` | Agent skill installer | — |
| `diffmode commands` | Machine-readable manifest | — |

Full per-command reference: [`skills/diffmode/references/commands.md`](skills/diffmode/references/commands.md).

Submit commands (`run`, `workflow`, `unlock`, `idea-eval`, `smoke-test`) do a
pre-flight `GET /billing/balance` before posting and exit 8 if the wallet
balance is below the module cost. Pass `--no-preflight` to skip it when the
agent has already verified credits this turn.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | OK |
| `1` | Generic error |
| `2` | Usage error (bad flags, missing required input) |
| `3` | Network |
| `4` | Auth (invalid/revoked token) |
| `5` | Conflict (in-flight job for the same product) |
| `6` | Not found |
| `7` | Rate-limited (Retry-After) |
| `8` | Insufficient credits (top up via the browser) |
| `9` | Server (5xx) |
| `10` | Interrupted but resumable (`diffmode jobs resume`) |
| `130` | SIGINT (Ctrl-C; never cancels the server-side job) |

Full per-code recovery guidance: [`skills/diffmode/references/error-codes.md`](skills/diffmode/references/error-codes.md).

## Agent integration

`diffmode` ships an Anthropic-format skill (`SKILL.md`), an `AGENTS.md`
companion, an `llms.txt`, and a Cursor MDC rule — all generated from one
source so they don't drift.

Install them into your agent's known location:

```bash
# Install into Claude Code, Codex, and Cursor (default)
diffmode skill install

# Or pick a target
diffmode skill install --target claude
diffmode skill install --target cursor

# Inspect what would happen first
diffmode skill install --dry-run
diffmode skill install --print-paths
```

Default destinations:

| Target | Path |
| --- | --- |
| Claude Code | `~/.claude/skills/diffmode/SKILL.md` |
| Codex | `~/.codex/skills/diffmode/SKILL.md` |
| Cursor | `~/.cursor/rules/diffmode.mdc` |

Override with the env vars `DIFFMODE_SKILL_CLAUDE_PATH`,
`DIFFMODE_SKILL_CODEX_PATH`, `DIFFMODE_SKILL_CURSOR_PATH`.

To preview the skill text without installing: `diffmode skill show`.

## Configuration

`diffmode` reads configuration in this order:

1. Per-command flag (e.g., `--token`, `--timeout`, `--profile`)
2. Environment variable
3. Built-in defaults

A `~/.config/diffmode/config.json` profile registry is planned for Phase 2;
0.1.0 only reads the env vars below.

### Environment variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `DIFFMODE_TOKEN` | PAT (overrides stored, beaten by `--token`) | — |
| `DIFFMODE_API_BASE` | API base URL | `https://ai-cmo-api.onrender.com/public/v1` |
| `DIFFMODE_BILLING_URL` | Billing redirect URL | `https://diffmode.app/app/billing` |
| `DIFFMODE_PROFILE` | Active profile name (overridden by `--profile`) | `default` |
| `DIFFMODE_SKILL_CLAUDE_PATH` | Override Claude skill install target | `~/.claude/skills/diffmode/SKILL.md` |
| `DIFFMODE_SKILL_CODEX_PATH` | Override Codex skill install target | `~/.codex/skills/diffmode/SKILL.md` |
| `DIFFMODE_SKILL_CURSOR_PATH` | Override Cursor MDC install target | `~/.cursor/rules/diffmode.mdc` |
| `NO_COLOR=1` | Disable ANSI colors | — |

The active profile is used as the keyring account name, so different
profiles can hold independent PATs (`diffmode --profile staging login …`).

Tokens are stored separately in the OS keyring (`keytar`) — or in a
mode-`0600` fallback file with a one-time stderr warning when the keyring
isn't available.

## JSON output contract

Every command emits JSON when stdout is not a TTY (or when `--json` is set).
The envelope is schema-versioned:

> **Cat-style exception:** `diffmode results --show <path>` and `diffmode
> skill show` stream raw file/markdown contents to stdout by default so
> `diffmode skill show > SKILL.md` and `diffmode results <p> --show <path>
> > out.md` work as documented. Pass `--json` explicitly to get the
> `{path, contents}` envelope on these two read-out commands; on `--show`
> the envelope also carries `truncated: true` when `--max-tokens` clipped
> the body.

```json
{ "schema_version": "1", "job_id": "…", "status": "running" }
```

Errors go to **stderr** with the same envelope shape:

```json
{ "error": { "code": "auth", "message": "…", "retryable": false } }
```

For agent self-discovery, run `diffmode commands` — it dumps the full
commander tree as a stable, machine-readable manifest.

## Idempotency

`Idempotency-Key` is the agent's responsibility (matches `gh` / `stripe`
conventions). Generate a UUIDv4 and pass `--idempotency-key <uuid>` on each
submit (`run`, `workflow`, `unlock`, `idea-eval`, `smoke-test`). Same key +
same user → same `job_id` back (no double-charge). The CLI never
auto-generates the key.

## Security

- The CLI **never logs the `Authorization` header value**, even with
  `--verbose` (redacted to `Bearer ***`).
- `login` reads a PAT from stdin or `--token` but never echoes it back.
- The mode-`0600` credential file fallback is only used when the OS keyring
  is unavailable; the CLI prints a one-time stderr warning when it falls
  back.

Report security issues per [`SECURITY.md`](SECURITY.md).

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

Apache-2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
