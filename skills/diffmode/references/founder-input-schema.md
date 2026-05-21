# Founder input schema (`FounderDiagnostics`)

`diffmode run`, `diffmode workflow`, and `diffmode smoke-test` all accept a
founder-input JSON object via `--input <file|->`. The schema mirrors the
backend Pydantic class `FounderDiagnostics` in the upstream Diffmode API
(`src/api/models.py`).

> **Drift policy:** regenerate this file whenever
> `models.py:FounderDiagnostics` changes. Treat the Pydantic class as the
> source of truth; this document is a developer-facing mirror. The CLI
> parser intentionally tolerates unknown keys (`extra="allow"`) so adding
> a field to the backend never breaks an existing client.

## Required

- **`product_description`** *(string, non-empty)* — what the product does.
  This is the only hard-required field. Missing it → CLI exits 2 with a
  pointer to this file.

## Recommended (warn if missing)

These fields meaningfully sharpen the generated plan; the CLI prints a
non-fatal stderr warning when they're absent.

- `target_audience` *(string)* — current or target customers.
- `trigger_events` *(string)* — moments customers need the solution.
- `pricing` *(string)* — business model and pricing.
- `acquisition_sources` *(string)* — where customers come from today.
- `current_growth` *(object|null)* — last-30-days traffic + conversion.

## Optional — diagnostics (v2.2)

- `alternatives_used` *(string)*
- `marketing_experiments` *(string)*
- `tactics_ruled_out` *(string)*
- `goals` *(string)*
- `budget` *(string)* — monthly budget shorthand.
- `product_complexity` *(object|null)* — `{ type, details }`. `from-url`
  pre-fill populates this when the analysis returns a complexity hint.
- `resource_constraints` *(object|null)*
- `problem_urgency` *(object|null)*
- `challenges` *(object|null)*

## Optional — business / team context

- `business_model` *(string)*
- `current_mrr` *(string)*
- `funding_stage` *(string)*
- `team_size` *(string)*
- `your_role` *(string)*
- `marketing_team_size` *(string)*
- `resource_profile` *(string)* — `"solo"` / `"small_team"` / `"dedicated"`.

## Optional — persona & customer mix

- `persona_type` *(string)* — founder vs marketing-hire framing.
- `observed_customers` *(string)*
- `customer_mix` *(string)*
- `top_competitors` *(string)*
- `what_makes_you_different` *(string)*
- `channels_tried_raw` *(string | string[])*

## Optional — growth & retention signals

- `retention_signal` *(string)*
- `emotional_signals` *(string)*
- `blind_spots` *(string)*
- `comprehension_friction` *(string)*
- `comfortable_with_outreach` *(`""` | `"yes"` | `"no"`)*
- `trigger_events_source` *(string)*

## Extra keys

The backend accepts arbitrary additional keys (`extra="allow"`). The
parent diagnostics formatter renders them under an "Additional Context"
section. **Reserved keys** (`user_id`, `created_at`, `updated_at`, `id`,
`job_id`, `product_id`) are server-managed and rejected by the CLI before
submit.

## Example

```json
{
  "product_description": "Drop-in fraud-detection API for fintech apps.",
  "pricing": "Usage-based — $0.002/request after a 10k-request free tier.",
  "target_audience": "Series-A fintechs adding their first underwriting team.",
  "trigger_events": "First fraud incident or compliance review.",
  "acquisition_sources": "Founder outbound + a small founder-led community.",
  "current_growth": { "traffic_30d": 12000, "conversion_rate": 0.018 },
  "goals": "$50k MRR in 6 months."
}
```

## Pre-fill from a URL

`diffmode diagnostics from-url https://your-site.example` calls
`POST /public/v1/analyze-website` and emits a draft `FounderDiagnostics`
JSON. Field mapping:

| Response field                            | FounderDiagnostics field          |
|-------------------------------------------|-----------------------------------|
| `company_description`                     | `product_description`             |
| `analysis_pricing`                        | `pricing`                         |
| `target_customer`                         | `target_audience`                 |
| `analysis_trigger_events`                 | `trigger_events`                  |
| `how_customers_find_you_today`            | `acquisition_sources`             |
| `top_competitors`                         | `top_competitors`                 |
| `what_makes_you_different`                | `what_makes_you_different`        |
| `analysis_product_complexity_type` + `_details` | `product_complexity` *(object)* |

`auto_filled_fields` / `draft_fields` from the response are logged to
stderr (not part of the diagnostics object) so you can tell which fields
are confident vs. best-guess. Always review draft fields before submit.
