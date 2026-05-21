import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseFrontmatter,
  validateSkillFrontmatter,
  REQUIRED_TRIGGER_PHRASES,
} from "../src/lib/skill-validator";

const SKILL_PATH = resolve(__dirname, "..", "skills", "diffmode", "SKILL.md");

describe("parseFrontmatter", () => {
  it("extracts YAML key/value pairs delimited by --- fences", () => {
    const md = `---\nname: diffmode\ndescription: A description\n---\n\nbody\n`;
    const fm = parseFrontmatter(md);
    expect(fm).toEqual({
      name: "diffmode",
      description: "A description",
    });
  });

  it("preserves multi-line description folded values via plain newlines", () => {
    const md =
      `---\nname: diffmode\ndescription: line one continues line two.\n---\n\nbody\n`;
    const fm = parseFrontmatter(md);
    expect(fm["description"]).toContain("line one");
  });

  it("returns an empty object when no frontmatter block is present", () => {
    expect(parseFrontmatter("# just markdown\n")).toEqual({});
  });

  it("throws when the opening --- is present but never closed", () => {
    expect(() => parseFrontmatter("---\nname: x\n")).toThrow(/unterminated/i);
  });
});

describe("validateSkillFrontmatter", () => {
  it("accepts a well-formed frontmatter with all required trigger phrases", () => {
    const fm = {
      name: "diffmode",
      description:
        "Use this skill whenever the user wants a growth plan, says diffmode run, asks about personas, or wants a focus group simulation. Operates the diffmode CLI.",
    };
    const result = validateSkillFrontmatter(fm);
    expect(result.ok).toBe(true);
  });

  it("rejects missing `name`", () => {
    const result = validateSkillFrontmatter({ description: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("\n")).toContain("name");
  });

  it("rejects missing `description`", () => {
    const result = validateSkillFrontmatter({ name: "diffmode" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("\n")).toContain("description");
  });

  it("rejects when a required trigger phrase is absent", () => {
    const fm = {
      name: "diffmode",
      description: "A description with no trigger phrases at all.",
    };
    const result = validateSkillFrontmatter(fm);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const joined = result.errors.join("\n");
      // At least one of the required phrases should be flagged
      expect(joined.toLowerCase()).toContain("trigger phrase");
    }
  });

  it("lists the canonical trigger phrases from the spec", () => {
    expect(REQUIRED_TRIGGER_PHRASES).toContain("growth plan");
    expect(REQUIRED_TRIGGER_PHRASES).toContain("diffmode run");
    expect(REQUIRED_TRIGGER_PHRASES).toContain("personas");
    expect(REQUIRED_TRIGGER_PHRASES).toContain("focus group");
  });
});

describe("skills/diffmode/SKILL.md on disk", () => {
  it("exists and parses to a valid frontmatter block", () => {
    const md = readFileSync(SKILL_PATH, "utf8");
    const fm = parseFrontmatter(md);
    expect(fm["name"]).toBe("diffmode");
    expect(typeof fm["description"]).toBe("string");
  });

  it("passes the full validator (required keys + trigger phrases)", () => {
    const md = readFileSync(SKILL_PATH, "utf8");
    const fm = parseFrontmatter(md);
    const result = validateSkillFrontmatter(fm);
    if (!result.ok) {
      // Surface the missing-piece list so failures are diagnostic.
      throw new Error(`SKILL.md frontmatter invalid:\n${result.errors.join("\n")}`);
    }
    expect(result.ok).toBe(true);
  });
});
