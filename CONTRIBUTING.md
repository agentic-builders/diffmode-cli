# Contributing to `diffmode`

`diffmode` is the public, agent-drivable TypeScript CLI for the Diffmode
growth pipeline. This file covers the dev workflow at the v0.1.x phase. A
fuller contributor guide ships in v0.2 (Phase 3 / D4).

## Prerequisites

- Node ≥ 20
- npm ≥ 10

## Local setup

```bash
git clone https://github.com/agentic-builders/diffmode-cli.git
cd diffmode-cli
npm install
npm test
npm run lint
npm run typecheck
npm run build
```

All four commands must pass before any PR is mergeable — the GitHub Actions
workflow runs the same matrix on Node 20 + 22.

## Development workflow

1. **Open an issue first** for non-trivial changes (new commands, JSON
   envelope changes, exit-code changes). The agent contract is part of the
   public API; we want one PR per intentional contract change.
2. **TDD.** Write the failing test first, then implement to green. The
   project uses `vitest` + `msw` (HTTP mocks at the network boundary —
   never mock the function under test).
3. **Update docs and the manifest at the same time as the code.**
   `references/commands.md`, `references/error-codes.md`, and
   `SKILL.md` are versioned alongside the binary; the
   `commands-reference-drift.test.ts` check fails CI if a documented
   command is missing from the manifest.
4. **Companion files (`AGENTS.md`, `llms.txt`, `.cursor/rules/diffmode.mdc`)
   are generated.** Edit `SKILL.md`, then run:
   ```bash
   npm run sync:companions
   ```
   Don't hand-edit the generated files — the sync test fails CI if they
   drift.

## Code style

- TypeScript strict mode, no implicit `any`, `noUncheckedIndexedAccess`.
- Format follows the existing tree; no Prettier config (yet).
- Keep `dist/` out of commits — `npm publish` ships it.

## Tests

- `npm test` — runs the full Vitest suite.
- `npm run test:watch` — TDD loop.
- Integration tests use `msw` against `/public/v1/*`. New endpoints belong
  in `test/msw/handlers.ts`.

## Public-API stability

- The JSON envelope (`schema_version: "1"`), exit codes, and command names
  are part of the public contract. Bump `schema_version` and update
  `references/error-codes.md` before introducing a breaking change.
- Never log the `Authorization` header value, even with `--verbose`.

## Releasing

See [`docs/cli/diffmode-cli-spec.md`](../docs/cli/diffmode-cli-spec.md) §9
for the phased plan. `npm publish` is gated on:

- `npm test && npm run lint && npm run typecheck && npm run build` green
- Bundle size < 1 MB (target ≤ 500 kB)
- Manifest snapshot stable (`diffmode commands --json`)

## License

By contributing, you agree your contributions are licensed under
[Apache-2.0](LICENSE).
