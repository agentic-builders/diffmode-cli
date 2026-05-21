// Lightweight YAML-frontmatter parser + validator for Anthropic skill files.
// Intentionally avoids a YAML dep — frontmatter for our skills only uses flat
// `key: value` pairs. If a future skill needs nested structures, swap in a
// proper YAML parser at the cost of bundle weight.

export type Frontmatter = Record<string, string>;

// Canonical trigger phrases the spec (§Recommended SKILL.md skeleton v0)
// expects to appear in the description so the skill triggers reliably.
export const REQUIRED_TRIGGER_PHRASES = [
  "growth plan",
  "diffmode run",
  "personas",
  "focus group",
] as const;

const REQUIRED_KEYS = ["name", "description"] as const;

export function parseFrontmatter(source: string): Frontmatter {
  if (!source.startsWith("---")) return {};

  const lines = source.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return {};

  const closingIdx = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (closingIdx === -1) {
    throw new Error("Unterminated frontmatter: missing closing `---` fence.");
  }

  const out: Frontmatter = {};
  for (let i = 1; i < closingIdx; i += 1) {
    const line = lines[i] ?? "";
    if (line.trim().length === 0) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key.length === 0) continue;
    out[key] = value;
  }
  return out;
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: string[] };

export function validateSkillFrontmatter(fm: Frontmatter): ValidationResult {
  const errors: string[] = [];

  for (const key of REQUIRED_KEYS) {
    const value = fm[key];
    if (typeof value !== "string" || value.length === 0) {
      errors.push(`Missing required frontmatter key: \`${key}\`.`);
    }
  }

  const description = (fm["description"] ?? "").toLowerCase();
  if (description.length > 0) {
    for (const phrase of REQUIRED_TRIGGER_PHRASES) {
      if (!description.includes(phrase)) {
        errors.push(
          `Description is missing the required trigger phrase \`${phrase}\`.`,
        );
      }
    }
  }

  if (errors.length === 0) return { ok: true };
  return { ok: false, errors };
}
