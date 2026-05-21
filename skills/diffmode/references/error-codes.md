# Exit codes reference

`diffmode`'s exit codes are part of the public contract — agents and shell
scripts branch on them. The table below is verbatim from spec §8.

| Code | Name | Trigger | Recovery |
| --- | --- | --- | --- |
| `0` | OK | Command succeeded. | None. |
| `1` | GENERIC | Unclassified failure. | Surface stderr `error.message` to the user. |
| `2` | USAGE | Wrong flags, missing args, schema violations, "module not resumable", "no prior free-tier", … | Read stderr; fix the invocation. |
| `3` | NETWORK | DNS, TLS, connection-reset, response-body parse failure. | Check connectivity; retry with backoff (≤ 3 attempts). |
| `4` | AUTH | No token, expired/revoked PAT, or 401 from server. | Ask the user to run `diffmode login`, then retry. |
| `5` | CONFLICT (409) | A job is already running for this product. | Parse stderr `error.job_id`; switch to `diffmode jobs watch <id>`. |
| `6` | NOT_FOUND | 404 from server (unknown job id, missing product). | Verify the id/product slug. |
| `7` | RATE_LIMITED (429) | Free-tier limit (3 submits / 24 h) or `Retry-After` set. | Honor `error.retry_after` (seconds); sleep and retry. |
| `8` | INSUFFICIENT_CREDITS (402) | Pre-flight or server rejected the submit. | Print `error.billing_url`; instruct the user to top up at `https://diffmode.app/app/billing`. **Do not retry.** |
| `9` | SERVER | 5xx. | If `error.retryable === true`, retry with backoff. Otherwise stop and surface. |
| `10` | INTERRUPTED_RESUMABLE | Server marked the job interrupted (deploy/rotation). | Run `diffmode jobs resume <id>` once, then `diffmode jobs watch <id>` again. |
| `130` | SIGINT | User hit Ctrl-C. | Print resume hint (the server job is still running); do NOT auto-cancel. |

## Per-code recovery scripts

### Exit 4 (AUTH)

```bash
diffmode whoami --json
# exit 4 → prompt user
echo "Please authenticate, then re-run."
echo "  npx diffmode@latest login   (paste PAT from https://diffmode.app/app/tokens)"
exit 4
```

### Exit 5 (CONFLICT — in-flight job)

The error envelope on stderr carries the running `job_id`:

```json
{"error": {"code": "conflict", "message": "...", "retryable": false, "job_id": "<id>", "product_id": "<p>"}}
```

Pivot to watching that job:

```bash
diffmode run "$PRODUCT" --input founder.json --idempotency-key "$UUID" --json
# if exit 5:
JOB_ID=$(jq -r '.error.job_id' /tmp/stderr.json)
diffmode jobs watch "$JOB_ID" --json --wait 4h
```

### Exit 7 (RATE_LIMITED)

Read `error.retry_after` (seconds). If ≤ 300, sleep and retry once. If
larger, surface to the user — don't loop silently.

### Exit 8 (INSUFFICIENT_CREDITS)

Browser-only top-up. The CLI **never** calls `POST /billing/checkout`. The
error payload includes the billing URL the CLI resolves at runtime:

```json
{"error": {"code": "insufficient_credits", "message": "...", "retryable": false, "billing_url": "https://diffmode.app/app/billing"}}
```

Tell the user, do not retry:

```
You're out of credits. Top up at https://diffmode.app/app/billing,
then re-run `diffmode run <product>`.
```

### Exit 10 (INTERRUPTED_RESUMABLE)

Workflow + free-tier are resumable; idea-eval, smoke-test, and unlock are
not. `diffmode jobs resume` handles the module branching for you:

```bash
diffmode jobs resume "$JOB_ID" --json
diffmode jobs watch "$JOB_ID" --json --wait 4h
```

If `jobs resume` itself exits 2 with "module not resumable", resubmit:

```bash
diffmode "$MODULE" "$PRODUCT" --input founder.json --idempotency-key "$NEW_UUID"
```

### Exit 130 (SIGINT)

The server-side job keeps running. Confirm with the user; if they want to
keep going:

```bash
diffmode jobs watch "$JOB_ID" --json --wait 4h
```

Do NOT issue `DELETE /jobs/{id}` on Ctrl-C — the CLI deliberately skips
that to keep jobs durable across watch interruptions.

## Coverage per command

The exact exit-code set per command is in `commands.md` (and emitted by
`diffmode commands --json` under each entry's `exits` field). This file
documents the codes themselves; that file documents which commands can emit
which codes.

## Drift policy

This table mirrors `src/lib/exit-codes.ts` (constants) and spec §8 (the
authoritative source). If you change a code's number or name:

1. Update `src/lib/exit-codes.ts`.
2. Update the constant test in `test/exit-codes.test.ts`.
3. Update this file + `commands.md`.
4. Bump `schema_version` if the JSON envelope's `error.code` strings
   change semantically.

The CI matrix in `test/exit-codes.test.ts` enforces constants vs. spec
parity; this doc is for humans + agents.
