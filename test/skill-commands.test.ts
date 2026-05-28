import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  skillShowCommand,
  skillInstallCommand,
  skillUninstallCommand,
} from "../src/commands/skill";
import { resetOutputConfig, setOutputConfig } from "../src/lib/output";

const SKILL_SAMPLE = `---
name: diffmode
description: test skill
---

# Diffmode

Hello from the bundled skill.
`;

const CURSOR_SAMPLE = `---
description: diffmode CLI rule
alwaysApply: false
---

Use the diffmode CLI to drive growth runs.
`;

type Captured = { stdout: string; stderr: string; exitCode?: number };
function captureStreams(): Captured {
  const captured: Captured = { stdout: "", stderr: "" };
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: any) => {
    captured.stdout += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  }) as any);
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: any) => {
    captured.stderr += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  }) as any);
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    captured.exitCode = code ?? 0;
    throw new Error(`__exit__:${code ?? 0}`);
  }) as any);
  return captured;
}

let workspace: string;
let skillRoot: string;
let claudePath: string;
let codexPath: string;
let cursorPath: string;

beforeEach(() => {
  resetOutputConfig();
  setOutputConfig({ json: true });

  workspace = mkdtempSync(join(tmpdir(), "diffmode-skill-"));
  skillRoot = join(workspace, "skills", "diffmode");
  mkdirSync(join(skillRoot, ".cursor", "rules"), { recursive: true });
  writeFileSync(join(skillRoot, "SKILL.md"), SKILL_SAMPLE);
  writeFileSync(join(skillRoot, ".cursor", "rules", "diffmode.mdc"), CURSOR_SAMPLE);

  const claudeHome = join(workspace, ".claude");
  const codexHome = join(workspace, ".codex");
  const cursorHome = join(workspace, ".cursor");
  mkdirSync(claudeHome, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(cursorHome, { recursive: true });
  claudePath = join(claudeHome, "skills", "diffmode", "SKILL.md");
  codexPath = join(codexHome, "skills", "diffmode", "SKILL.md");
  cursorPath = join(cursorHome, "rules", "diffmode.mdc");
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  vi.restoreAllMocks();
  resetOutputConfig();
});

describe("diffmode skill show", () => {
  it("prints the bundled SKILL.md contents on --json", async () => {
    const cap = captureStreams();
    await skillShowCommand({ skillRoot });
    const parsed = JSON.parse(cap.stdout);
    expect(parsed.schema_version).toBe("1");
    expect(parsed.path).toBe(join(skillRoot, "SKILL.md"));
    expect(parsed.contents).toBe(SKILL_SAMPLE);
  });

  it("prints raw SKILL.md text to stdout on a TTY (no JSON envelope)", async () => {
    resetOutputConfig();
    setOutputConfig({ json: false, isTTY: true });
    const cap = captureStreams();
    await skillShowCommand({ skillRoot });
    expect(cap.stdout).toBe(SKILL_SAMPLE);
    expect(cap.stdout).not.toContain("schema_version");
  });

  it("prints raw SKILL.md text on a piped stdout without --json so `> file` works", async () => {
    resetOutputConfig();
    setOutputConfig({ json: false, isTTY: false });
    const cap = captureStreams();
    await skillShowCommand({ skillRoot });
    expect(cap.stdout).toBe(SKILL_SAMPLE);
    expect(cap.stdout).not.toContain("schema_version");
  });

  it("exits 1 with a useful message when the bundled skill is missing", async () => {
    const broken = join(workspace, "missing-skill-root");
    const cap = captureStreams();
    let threw = false;
    try {
      await skillShowCommand({ skillRoot: broken });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(cap.exitCode).toBe(1);
    expect(cap.stderr).toContain("SKILL.md");
  });
});

describe("diffmode skill install --print-paths", () => {
  it("emits the resolved paths for each target and writes nothing", async () => {
    const cap = captureStreams();
    await skillInstallCommand({
      skillRoot,
      target: "all",
      printPaths: true,
      claudePath,
      codexPath,
      cursorPath,
    });
    const parsed = JSON.parse(cap.stdout);
    expect(parsed.schema_version).toBe("1");
    expect(parsed.paths.claude).toBe(claudePath);
    expect(parsed.paths.codex).toBe(codexPath);
    expect(parsed.paths.cursor).toBe(cursorPath);
    expect(existsSync(claudePath)).toBe(false);
    expect(existsSync(codexPath)).toBe(false);
    expect(existsSync(cursorPath)).toBe(false);
  });
});

describe("diffmode skill install (write paths)", () => {
  it("installs SKILL.md for claude target only", async () => {
    const cap = captureStreams();
    await skillInstallCommand({
      skillRoot,
      target: "claude",
      claudePath,
      codexPath,
      cursorPath,
    });
    const parsed = JSON.parse(cap.stdout);
    expect(parsed.schema_version).toBe("1");
    expect(parsed.installed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: "claude", action: "installed" }),
      ]),
    );
    expect(existsSync(claudePath)).toBe(true);
    expect(readFileSync(claudePath, "utf8")).toBe(SKILL_SAMPLE);
    expect(existsSync(codexPath)).toBe(false);
    expect(existsSync(cursorPath)).toBe(false);
  });

  it("installs SKILL.md for codex target only", async () => {
    captureStreams();
    await skillInstallCommand({
      skillRoot,
      target: "codex",
      claudePath,
      codexPath,
      cursorPath,
    });
    expect(existsSync(codexPath)).toBe(true);
    expect(readFileSync(codexPath, "utf8")).toBe(SKILL_SAMPLE);
    expect(existsSync(claudePath)).toBe(false);
  });

  it("installs the Cursor MDC file for cursor target only", async () => {
    captureStreams();
    await skillInstallCommand({
      skillRoot,
      target: "cursor",
      claudePath,
      codexPath,
      cursorPath,
    });
    expect(existsSync(cursorPath)).toBe(true);
    expect(readFileSync(cursorPath, "utf8")).toBe(CURSOR_SAMPLE);
  });

  it("default target=all writes all three", async () => {
    captureStreams();
    await skillInstallCommand({
      skillRoot,
      claudePath,
      codexPath,
      cursorPath,
    });
    expect(existsSync(claudePath)).toBe(true);
    expect(existsSync(codexPath)).toBe(true);
    expect(existsSync(cursorPath)).toBe(true);
  });

  it("creates parent directories as needed (mkdir -p)", async () => {
    captureStreams();
    await skillInstallCommand({
      skillRoot,
      target: "claude",
      claudePath,
      codexPath,
      cursorPath,
    });
    // The intermediate `skills/diffmode/` directory was created implicitly.
    expect(statSync(claudePath).isFile()).toBe(true);
  });

  it("is idempotent: re-installing the same content reports `unchanged`", async () => {
    captureStreams();
    await skillInstallCommand({
      skillRoot,
      target: "claude",
      claudePath,
      codexPath,
      cursorPath,
    });
    vi.restoreAllMocks();
    const cap = captureStreams();
    await skillInstallCommand({
      skillRoot,
      target: "claude",
      claudePath,
      codexPath,
      cursorPath,
    });
    const parsed = JSON.parse(cap.stdout);
    expect(parsed.installed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: "claude", action: "unchanged" }),
      ]),
    );
  });

  it("on differing content, refuses without --yes and reports `needs-confirm`", async () => {
    mkdirSync(join(claudePath, ".."), { recursive: true });
    writeFileSync(claudePath, "OLD CONTENT");
    const cap = captureStreams();
    await skillInstallCommand({
      skillRoot,
      target: "claude",
      claudePath,
      codexPath,
      cursorPath,
    });
    const parsed = JSON.parse(cap.stdout);
    expect(parsed.installed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: "claude", action: "needs-confirm" }),
      ]),
    );
    expect(readFileSync(claudePath, "utf8")).toBe("OLD CONTENT");
    expect(cap.stderr).toContain("--yes");
  });

  it("on differing content with --yes, overwrites and reports `updated`", async () => {
    mkdirSync(join(claudePath, ".."), { recursive: true });
    writeFileSync(claudePath, "OLD CONTENT");
    const cap = captureStreams();
    await skillInstallCommand({
      skillRoot,
      target: "claude",
      yes: true,
      claudePath,
      codexPath,
      cursorPath,
    });
    const parsed = JSON.parse(cap.stdout);
    expect(parsed.installed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: "claude", action: "updated" }),
      ]),
    );
    expect(readFileSync(claudePath, "utf8")).toBe(SKILL_SAMPLE);
  });

  it("--dry-run never writes; reports the action it would have taken", async () => {
    const cap = captureStreams();
    await skillInstallCommand({
      skillRoot,
      target: "all",
      dryRun: true,
      claudePath,
      codexPath,
      cursorPath,
    });
    const parsed = JSON.parse(cap.stdout);
    expect(parsed.dry_run).toBe(true);
    expect(parsed.installed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: "claude", action: "would-install" }),
        expect.objectContaining({ target: "codex", action: "would-install" }),
        expect.objectContaining({ target: "cursor", action: "would-install" }),
      ]),
    );
    expect(existsSync(claudePath)).toBe(false);
    expect(existsSync(codexPath)).toBe(false);
    expect(existsSync(cursorPath)).toBe(false);
  });

  it("skips a target whose tool root dir is missing (Claude Code not installed)", async () => {
    rmSync(join(workspace, ".claude"), { recursive: true, force: true });
    const cap = captureStreams();
    await skillInstallCommand({
      skillRoot,
      target: "all",
      claudePath,
      codexPath,
      cursorPath,
    });
    const parsed = JSON.parse(cap.stdout);
    expect(parsed.installed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: "claude", action: "skipped" }),
        expect.objectContaining({ target: "codex", action: "installed" }),
        expect.objectContaining({ target: "cursor", action: "installed" }),
      ]),
    );
    expect(cap.stderr).toContain("Claude");
    expect(existsSync(claudePath)).toBe(false);
  });
});

describe("diffmode skill uninstall", () => {
  // Helper: pre-populate destination with the bundled content
  // (equivalent to running `skill install --target all` first).
  function preinstall(dest: string, content: string): void {
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(dest, content);
  }

  it("removes a matching file and reports `removed`", async () => {
    preinstall(claudePath, SKILL_SAMPLE);
    const cap = captureStreams();
    await skillUninstallCommand({
      skillRoot,
      target: "claude",
      claudePath,
      codexPath,
      cursorPath,
    });
    const parsed = JSON.parse(cap.stdout);
    expect(parsed.schema_version).toBe("1");
    expect(parsed.uninstalled).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: "claude", action: "removed" }),
      ]),
    );
    expect(existsSync(claudePath)).toBe(false);
  });

  it("reports `not-installed` when the file is absent (no-op)", async () => {
    const cap = captureStreams();
    await skillUninstallCommand({
      skillRoot,
      target: "claude",
      claudePath,
      codexPath,
      cursorPath,
    });
    const parsed = JSON.parse(cap.stdout);
    expect(parsed.uninstalled).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: "claude", action: "not-installed" }),
      ]),
    );
    expect(existsSync(claudePath)).toBe(false);
  });
});
