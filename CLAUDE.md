# CLAUDE.md — diffmode-cli

Guidance for AI agents working in `diffmode-cli/`. This is the public,
agent-drivable TypeScript CLI that wraps `/public/v1/*`. Unlike the rest of
this monorepo (prompt-as-software), this subdir IS a real Node app.

## Conventions

- **Language / runtime:** TypeScript, Node ≥ 20. Strict mode on; no implicit
  `any`; `noUncheckedIndexedAccess`.
- **Build:** `esbuild` → single CJS bundle at `dist/bin.js`. Native module
  `keytar` is `--external` and `optionalDependencies` (esbuild can't bundle
  prebuilt natives).
- **Command framework:** `commander` (battle-tested, widest LLM-training
  footprint, esbuild-friendly).
- **Tests:** `vitest` (run + watch); `msw` for HTTP mocks. **TDD: failing
  test first, then implementation.** No mocking the function under test —
  mock at the HTTP boundary only.
- **Lint / typecheck:** `eslint` (`@typescript-eslint`) + `tsc --noEmit`.
- **All four must pass before any task is "done":** `npm test && npm run
  lint && npm run typecheck && npm run build`.

## Hard rules

1. **JSON is the public API.** Every command emits `schema_version: "1"` on
   `--json` (or any non-TTY). Contract tests catch breaking changes — if
   you change the envelope shape, bump `schema_version` and update tests.
   Exception: cat-style `results --show` and `skill show` stream raw to
   stdout by default (so `> file` works); `--json` opts into the envelope.
2. **Never log `Authorization` header values.** Even with `--verbose`,
   redact to `Bearer ***`. `login` never echoes the PAT after acceptance.
3. **Stdout is data; stderr is progress/errors.** Mixing them breaks
   agent pipelines (`diffmode foo --json | jq ...`).
4. **Exit codes are part of the contract.** See `src/lib/exit-codes.ts`
   (spec §8 verbatim). Don't add new codes without updating
   `skills/diffmode/references/error-codes.md`.
5. **Credentials never persist in plaintext silently.** File fallback
   (mode 0600) prints a one-time stderr warning.
6. **CLI is read-only for billing.** No `topup`, no `POST /billing/checkout`.
   On 402: print billing URL + exit 8. Browser-only top-up by design.
7. **Idempotency-Key is OPTIONAL and SUBCOMMAND-scoped.** When the user
   omits `--idempotency-key`, the CLI does NOT auto-generate or send the
   header. Agents pass their own UUID (matches `gh`/`stripe` UX).
8. **Action handlers call `resolveActiveToken(globals)`, not `globals.token`** —
   resolves `--token` > `DIFFMODE_TOKEN` > stored; bypassing it skips env + keyring.

## What `dist/` is

Generated bundle. **Gitignored.** Don't commit it. `npm publish` ships it.

## Reference docs

- Quick start + commands: `README.md`
- Agent guidance: `skills/diffmode/SKILL.md` + `skills/diffmode/references/`
- Exit codes (source of truth): `src/lib/exit-codes.ts`
- Backend shapes live upstream in the (private) Diffmode API — when they change,
  mirror Pydantic → TS in `src/lib/http.ts` and regenerate `references/*-schema.md`
