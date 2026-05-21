import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { syncCompanions, writeCompanions, OUTPUT_BANNER } from "../scripts/sync-companions";

const SKILL_DIR = resolve(__dirname, "..", "skills", "diffmode");
const SKILL_PATH = resolve(SKILL_DIR, "SKILL.md");
const AGENTS_PATH = resolve(SKILL_DIR, "AGENTS.md");
const CURSOR_PATH = resolve(SKILL_DIR, ".cursor", "rules", "diffmode.mdc");
const LLMS_PATH = resolve(SKILL_DIR, "llms.txt");

describe("syncCompanions generator", () => {
  it("reads SKILL.md and returns three named outputs", () => {
    const skillSource = readFileSync(SKILL_PATH, "utf8");
    const outputs = syncCompanions(skillSource);
    expect(outputs.agents).toBeTypeOf("string");
    expect(outputs.cursor).toBeTypeOf("string");
    expect(outputs.llms).toBeTypeOf("string");
    expect(outputs.agents.length).toBeGreaterThan(0);
    expect(outputs.cursor.length).toBeGreaterThan(0);
    expect(outputs.llms.length).toBeGreaterThan(0);
  });

  it("AGENTS.md is under 2 KB (spec D2 ceiling)", () => {
    const skillSource = readFileSync(SKILL_PATH, "utf8");
    const { agents } = syncCompanions(skillSource);
    expect(Buffer.byteLength(agents, "utf8")).toBeLessThan(2048);
  });

  it("each output includes the DO NOT EDIT banner", () => {
    const skillSource = readFileSync(SKILL_PATH, "utf8");
    const outputs = syncCompanions(skillSource);
    expect(outputs.agents).toContain(OUTPUT_BANNER);
    expect(outputs.cursor).toContain(OUTPUT_BANNER);
    expect(outputs.llms).toContain(OUTPUT_BANNER);
    expect(OUTPUT_BANNER).toContain("DO NOT EDIT");
    expect(OUTPUT_BANNER).toContain("sync-companions.ts");
  });

  it("AGENTS.md condenses the essentials (when-to-use + exit codes + key commands)", () => {
    const skillSource = readFileSync(SKILL_PATH, "utf8");
    const { agents } = syncCompanions(skillSource);
    expect(agents).toContain("diffmode");
    // when-to-use surface
    expect(agents.toLowerCase()).toContain("growth plan");
    // key commands
    expect(agents).toContain("diffmode run");
    expect(agents).toContain("diffmode jobs watch");
    expect(agents).toContain("diffmode results");
    // exit codes appear (at least the resumable hint)
    expect(agents).toContain("10");
    expect(agents).toContain("8");
  });

  it("Cursor MDC has the documented MDC frontmatter shape", () => {
    const skillSource = readFileSync(SKILL_PATH, "utf8");
    const { cursor } = syncCompanions(skillSource);
    // MDC files open with `---` frontmatter
    expect(cursor.startsWith("---\n")).toBe(true);
    const fmEnd = cursor.indexOf("\n---\n", 4);
    expect(fmEnd).toBeGreaterThan(0);
    const fmBody = cursor.slice(4, fmEnd);
    // canonical Cursor MDC keys
    expect(fmBody).toMatch(/description:/);
    // either alwaysApply or globs must be present to scope the rule
    expect(/alwaysApply:|globs:/.test(fmBody)).toBe(true);
  });

  it("Cursor MDC body references diffmode commands and the public repo", () => {
    const skillSource = readFileSync(SKILL_PATH, "utf8");
    const { cursor } = syncCompanions(skillSource);
    expect(cursor).toContain("diffmode run");
    expect(cursor).toContain("https://github.com/agentic-builders/diffmode-cli");
  });

  it("llms.txt follows the Anthropic llms.txt convention", () => {
    const skillSource = readFileSync(SKILL_PATH, "utf8");
    const { llms } = syncCompanions(skillSource);
    // Anthropic llms.txt format: title on first non-banner line, > blockquote summary,
    // followed by markdown link sections
    const lines = llms.split("\n").filter((l) => !l.startsWith("<!--"));
    const title = lines.find((l) => l.startsWith("# "));
    expect(title).toBeDefined();
    expect(title?.toLowerCase()).toContain("diffmode");
    // pointer to public repo + frontend marketing site
    expect(llms).toContain("https://github.com/agentic-builders/diffmode-cli");
    expect(llms).toContain("https://diffmode.app");
    // does NOT reference a non-existent diffmode.dev domain
    expect(llms).not.toContain("diffmode.dev");
  });

  it("is idempotent: running twice on the same source yields the same outputs", () => {
    const skillSource = readFileSync(SKILL_PATH, "utf8");
    const a = syncCompanions(skillSource);
    const b = syncCompanions(skillSource);
    expect(a.agents).toBe(b.agents);
    expect(a.cursor).toBe(b.cursor);
    expect(a.llms).toBe(b.llms);
  });
});

describe("checked-in companion files match the generator output (drift check)", () => {
  it("AGENTS.md on disk matches the generated content", () => {
    const skillSource = readFileSync(SKILL_PATH, "utf8");
    const { agents } = syncCompanions(skillSource);
    expect(existsSync(AGENTS_PATH)).toBe(true);
    const onDisk = readFileSync(AGENTS_PATH, "utf8");
    if (onDisk !== agents) {
      throw new Error(
        "skills/diffmode/AGENTS.md is out of sync with sync-companions.ts. " +
          "Re-run `npm run sync:companions` (or `tsx scripts/sync-companions.ts`) to regenerate.",
      );
    }
    expect(onDisk).toBe(agents);
  });

  it(".cursor/rules/diffmode.mdc on disk matches the generated content", () => {
    const skillSource = readFileSync(SKILL_PATH, "utf8");
    const { cursor } = syncCompanions(skillSource);
    expect(existsSync(CURSOR_PATH)).toBe(true);
    const onDisk = readFileSync(CURSOR_PATH, "utf8");
    expect(onDisk).toBe(cursor);
  });

  it("llms.txt on disk matches the generated content", () => {
    const skillSource = readFileSync(SKILL_PATH, "utf8");
    const { llms } = syncCompanions(skillSource);
    expect(existsSync(LLMS_PATH)).toBe(true);
    const onDisk = readFileSync(LLMS_PATH, "utf8");
    expect(onDisk).toBe(llms);
  });
});

describe("sync-companions CLI entry-point", () => {
  it("writeCompanions writes all three files into a target dir", () => {
    const tmp = mkdtempSync(join(tmpdir(), "diffmode-sync-"));
    try {
      const skillSource = readFileSync(SKILL_PATH, "utf8");
      const skillStub = join(tmp, "SKILL.md");
      writeFileSync(skillStub, skillSource);
      const written = writeCompanions(tmp);
      expect(written.agents).toBe(join(tmp, "AGENTS.md"));
      expect(written.cursor).toBe(join(tmp, ".cursor", "rules", "diffmode.mdc"));
      expect(written.llms).toBe(join(tmp, "llms.txt"));
      expect(existsSync(written.agents)).toBe(true);
      expect(existsSync(written.cursor)).toBe(true);
      expect(existsSync(written.llms)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("running writeCompanions twice produces no diff (idempotent on-disk)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "diffmode-sync-"));
    try {
      const skillSource = readFileSync(SKILL_PATH, "utf8");
      writeFileSync(join(tmp, "SKILL.md"), skillSource);
      writeCompanions(tmp);
      const first = {
        agents: readFileSync(join(tmp, "AGENTS.md"), "utf8"),
        cursor: readFileSync(join(tmp, ".cursor", "rules", "diffmode.mdc"), "utf8"),
        llms: readFileSync(join(tmp, "llms.txt"), "utf8"),
      };
      writeCompanions(tmp);
      const second = {
        agents: readFileSync(join(tmp, "AGENTS.md"), "utf8"),
        cursor: readFileSync(join(tmp, ".cursor", "rules", "diffmode.mdc"), "utf8"),
        llms: readFileSync(join(tmp, "llms.txt"), "utf8"),
      };
      expect(second).toEqual(first);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
