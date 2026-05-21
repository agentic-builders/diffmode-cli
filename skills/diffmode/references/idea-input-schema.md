# IdeaInput schema

The `diffmode idea-eval` command accepts a structured JSON list of `IdeaInput`
objects, not free-text strings. This file mirrors the canonical Pydantic
shape declared in the upstream Diffmode API (`IdeaInput` in `src/api/models.py`,
~lines 43–83) — regenerate this doc when that class changes.

## Top-level shape

The ideas file passed via `--ideas-file <path>` MUST be a JSON array of
`IdeaInput` objects:

```json
[
  { "name": "…", "description": "…", … },
  { "name": "…", "description": "…", … }
]
```

A single-object file (`{"ideas": [...]}`) is **not** accepted — the array
must be the top-level value.

## Required fields

| Field | Type | Notes |
| --- | --- | --- |
| `name` | string (non-empty) | Idea name |
| `description` | string (non-empty) | One-sentence description |

## Optional fields

All optional fields default to `""` server-side and are forwarded into the
"Additional Context" section of the formatted prompt.

| Field | Type | Description |
| --- | --- | --- |
| `target_customer` | string | Target segment, B2B/B2C, ideal first 10 customers |
| `problem` | string | Pain point being solved, urgency, consequence of inaction |
| `solution` | string | Solution approach, how it solves, differentiation |
| `revenue_model` | string | Subscription, one-time, marketplace, etc. |
| `price_point` | string | Price point |
| `revenue_goal_min` | string | Minimum viable MRR + timeline |
| `revenue_goal_ambitious` | string | Ambitious revenue goal |
| `validation` | string | Existing validation: conversations, signups, prototypes |

## Extras

`IdeaInput` uses Pydantic `extra="allow"` — any additional fields you include
will be preserved and rendered in the formatted output under "Additional
Context". Use this to carry domain-specific metadata you want the model to
see.

## Example

```json
[
  {
    "name": "founder-mode-onboarding",
    "description": "Concierge onboarding videos recorded by the founder",
    "target_customer": "B2B SaaS solopreneurs $0–$10k MRR",
    "problem": "Activation drops 60% on day 2 of a free trial",
    "solution": "Loom-style 90s personalized welcome per signup",
    "revenue_model": "subscription, $79/mo add-on",
    "price_point": "$79/mo",
    "revenue_goal_min": "$2k MRR in 90 days",
    "validation": "12 founders agreed to pilot"
  }
]
```

## Companion flags

- `--intuition "<text>"` — founder's qualitative gut feel about the list
- `--target-idea "<slug>"` — evaluate a single idea (slug = name in
  kebab-case, e.g. `founder-mode-onboarding`)

## See also

- [`founder-input-schema.md`](./founder-input-schema.md) — diagnostics that
  `run` / `workflow` / `smoke-test` consume
- [`commands.md`](./commands.md) — endpoint + credit cost per command
- [`error-codes.md`](./error-codes.md) — exit-code recovery guide
