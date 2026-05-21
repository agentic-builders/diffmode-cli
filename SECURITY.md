# Security Policy

`diffmode` handles personal access tokens (PATs) and submits founder data
to a hosted growth-pipeline API. Security issues affect both the CLI
behavior and the user's stored credentials.

## Supported versions

| Version | Supported |
| --- | --- |
| `0.1.x` | ✅ Phase 1 — security fixes accepted |
| `< 0.1` | ❌ Not yet released |

## Reporting a vulnerability

Email **security@diffmode.app** with:

- A description of the issue and its impact
- Reproduction steps (CLI command, env, expected vs actual behavior)
- The version (`diffmode --version --json`) and OS

Please **do not** open a public GitHub issue for security findings. We aim
to respond within 5 business days and ship a patched release within 14
days for high-severity issues.

## Hard guarantees (any regression here is a security bug)

- The `Authorization` header value is **never** logged or printed,
  including with `--verbose`.
- `diffmode login` never echoes the PAT after acceptance.
- The credential file fallback at `~/.config/diffmode/auth.json` is mode
  `0600`. The CLI prints a one-time stderr warning when it falls back from
  the OS keyring.
- `diffmode jobs watch` never sends `DELETE /jobs/{id}` on Ctrl-C — the
  server-side job is durable; SIGINT only stops local polling.
- The CLI never invokes `POST /billing/checkout`. Top-up is browser-only
  by design; on `402`, the CLI prints a redirect URL and exits 8.

## Trust boundaries

- **Stored PAT** — keyring primary; mode-`0600` file fallback. Plain-text
  copy in the user's shell history is the user's responsibility (the CLI
  recommends piping or `--token` over typing).
- **`DIFFMODE_API_BASE`** — overridable. A malicious override can capture
  PATs; users override at their own risk.
- **`POST /public/v1/analyze-website`** sends a public URL to the backend.
  The CLI does not de-fang or rewrite the URL.

## Out of scope

- Issues in the hosted backend at `ai-cmo-api.onrender.com` — report those
  to the same address, but track separately.
- Bugs in `npx` / `npm` itself (`npm provenance` signing lands in Phase 3 /
  D4).
- Issues in third-party agents (Claude Code, Codex, Cursor) consuming the
  installed `SKILL.md` — report those to their respective vendors.
