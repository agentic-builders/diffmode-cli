import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import {
  printJson,
  printError,
  printProgress,
  getOutputConfig,
} from "../lib/output";
import { UsageError } from "../lib/errors";

export type SkillTarget = "claude" | "codex" | "cursor";
export type SkillTargetSelector = SkillTarget | "all";

type InstallAction =
  | "installed"
  | "unchanged"
  | "updated"
  | "needs-confirm"
  | "skipped"
  | "would-install"
  | "would-update"
  | "would-skip";

interface InstallResult {
  target: SkillTarget;
  path: string;
  action: InstallAction;
  reason?: string;
}

type UninstallAction =
  | "removed"
  | "not-installed"
  | "needs-confirm"
  | "would-remove";

interface UninstallResult {
  target: SkillTarget;
  path: string;
  action: UninstallAction;
  reason?: string;
}

const TARGET_LABELS: Record<SkillTarget, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
};

export interface SkillShowOptions {
  skillRoot?: string;
}

export interface SkillInstallOptions {
  target?: SkillTargetSelector;
  yes?: boolean;
  dryRun?: boolean;
  printPaths?: boolean;
  skillRoot?: string;
  // Resolved per-target target paths. bin.ts handles env-var override + home
  // expansion before calling in; tests inject these directly.
  claudePath?: string;
  codexPath?: string;
  cursorPath?: string;
}

export interface SkillUninstallOptions {
  target?: SkillTargetSelector;
  yes?: boolean;
  dryRun?: boolean;
  printPaths?: boolean;
  skillRoot?: string;
  // Resolved per-target target paths. bin.ts handles env-var override + home
  // expansion before calling in; tests inject these directly.
  claudePath?: string;
  codexPath?: string;
  cursorPath?: string;
}

// At runtime the bundled `dist/bin.js` sits next to a published `skills/`
// directory (`package.json#files`). In dev, `src/commands/skill.ts` is two
// levels deeper than `skills/`. Try both — first one that has `SKILL.md` wins.
const CANDIDATE_SKILL_ROOTS = [
  resolve(__dirname, "..", "skills", "diffmode"),
  resolve(__dirname, "..", "..", "skills", "diffmode"),
];

export function findBundledSkillRoot(): string {
  for (const candidate of CANDIDATE_SKILL_ROOTS) {
    if (existsSync(resolve(candidate, "SKILL.md"))) return candidate;
  }
  return CANDIDATE_SKILL_ROOTS[0]!;
}

export function defaultTargetPaths(): {
  claude: string;
  codex: string;
  cursor: string;
} {
  const home = homedir();
  return {
    claude: resolve(home, ".claude", "skills", "diffmode", "SKILL.md"),
    codex: resolve(home, ".codex", "skills", "diffmode", "SKILL.md"),
    cursor: resolve(home, ".cursor", "rules", "diffmode.mdc"),
  };
}

function toolRootForTarget(target: SkillTarget, targetPath: string): string {
  // The tool's home dir is the *first* segment under the user's home.
  // For the default `~/.claude/skills/diffmode/SKILL.md` we want `~/.claude`.
  // When the user has overridden the path via env-var, we still derive the
  // root the same way so missing-dir detection is consistent.
  const segments = targetPath.split(/[\\/]/);
  const idx = segments.findIndex(
    (s) => s === `.${target}` || s === target,
  );
  if (idx === -1) {
    // Fallback: parent of parent
    return dirname(dirname(targetPath));
  }
  return segments.slice(0, idx + 1).join("/");
}

function sourceFileFor(skillRoot: string, target: SkillTarget): string {
  if (target === "cursor") {
    return resolve(skillRoot, ".cursor", "rules", "diffmode.mdc");
  }
  return resolve(skillRoot, "SKILL.md");
}

function readSource(skillRoot: string, target: SkillTarget): string {
  const path = sourceFileFor(skillRoot, target);
  if (!existsSync(path)) {
    throw new UsageError(
      `Bundled skill file missing: ${path}. Reinstall the diffmode package.`,
    );
  }
  return readFileSync(path, "utf8");
}

function selectTargets(sel: SkillTargetSelector): SkillTarget[] {
  if (sel === "all") return ["claude", "codex", "cursor"];
  return [sel];
}

function installOne(
  target: SkillTarget,
  source: string,
  destPath: string,
  yes: boolean,
  dryRun: boolean,
): InstallResult {
  const toolRoot = toolRootForTarget(target, destPath);
  const exists = existsSync(destPath);
  const toolRootExists = existsSync(toolRoot);

  if (!toolRootExists && !exists) {
    return {
      target,
      path: destPath,
      action: dryRun ? "would-skip" : "skipped",
      reason: `${TARGET_LABELS[target]} dir not found at ${toolRoot}`,
    };
  }

  if (!exists) {
    if (dryRun) return { target, path: destPath, action: "would-install" };
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, source, { encoding: "utf8", mode: 0o644 });
    return { target, path: destPath, action: "installed" };
  }

  const current = readFileSync(destPath, "utf8");
  if (current === source) {
    return { target, path: destPath, action: "unchanged" };
  }
  if (!yes) {
    return {
      target,
      path: destPath,
      action: "needs-confirm",
      reason: "destination differs; re-run with --yes to overwrite",
    };
  }
  if (dryRun) return { target, path: destPath, action: "would-update" };
  writeFileSync(destPath, source, { encoding: "utf8", mode: 0o644 });
  return { target, path: destPath, action: "updated" };
}

function uninstallOne(
  target: SkillTarget,
  source: string,
  destPath: string,
  yes: boolean,
  dryRun: boolean,
): UninstallResult {
  if (!existsSync(destPath)) {
    return { target, path: destPath, action: "not-installed" };
  }

  const current = readFileSync(destPath, "utf8");
  if (current !== source && !yes) {
    return {
      target,
      path: destPath,
      action: "needs-confirm",
      reason: "destination differs from bundled; re-run with --yes to remove",
    };
  }

  if (dryRun) return { target, path: destPath, action: "would-remove" };

  unlinkSync(destPath);

  // Empty-parent cleanup: claude/codex own their `skills/diffmode/` parent
  // (created by install's mkdir -p). Cursor's parent is `~/.cursor/rules/`
  // which belongs to the tool itself — never touch it.
  if (target === "claude" || target === "codex") {
    const parent = dirname(destPath);
    try {
      if (existsSync(parent) && readdirSync(parent).length === 0) {
        rmdirSync(parent);
      }
    } catch {
      // Best-effort cleanup: ENOTEMPTY, ENOENT, EACCES — never fail the
      // overall action because of a parent-dir hiccup.
    }
  }

  return { target, path: destPath, action: "removed" };
}

export async function skillShowCommand(
  opts: SkillShowOptions = {},
): Promise<void> {
  const root = opts.skillRoot ?? findBundledSkillRoot();
  const path = resolve(root, "SKILL.md");
  if (!existsSync(path)) {
    printError(
      new Error(`Bundled SKILL.md not found at ${path}.`),
    );
  }
  const contents = readFileSync(path, "utf8");
  // Mirror `results --show`: file contents flow raw to stdout so
  // `diffmode skill show > SKILL.md` works as documented. The JSON envelope
  // is opt-in via explicit `--json` (not auto-enabled by a piped stdout),
  // since wrapping the body in JSON would defeat the "preview" use case.
  if (getOutputConfig().json) {
    printJson({ path, contents });
    return;
  }
  process.stdout.write(contents);
  if (!contents.endsWith("\n")) process.stdout.write("\n");
}

export async function skillInstallCommand(
  opts: SkillInstallOptions = {},
): Promise<void> {
  const root = opts.skillRoot ?? findBundledSkillRoot();
  const defaults = defaultTargetPaths();
  const claudePath = opts.claudePath ?? defaults.claude;
  const codexPath = opts.codexPath ?? defaults.codex;
  const cursorPath = opts.cursorPath ?? defaults.cursor;

  const paths: Record<SkillTarget, string> = {
    claude: claudePath,
    codex: codexPath,
    cursor: cursorPath,
  };

  if (opts.printPaths) {
    printJson({ paths });
    return;
  }

  const selector: SkillTargetSelector = opts.target ?? "all";
  const targets = selectTargets(selector);
  const dryRun = Boolean(opts.dryRun);
  const yes = Boolean(opts.yes);

  const installed: InstallResult[] = [];
  for (const t of targets) {
    let source: string;
    try {
      source = readSource(root, t);
    } catch (err) {
      printError(err);
      return;
    }
    const result = installOne(t, source, paths[t], yes, dryRun);
    installed.push(result);
    if (
      result.action === "skipped" ||
      result.action === "would-skip" ||
      result.action === "needs-confirm"
    ) {
      const tip =
        result.action === "needs-confirm"
          ? "Re-run with --yes to overwrite."
          : "";
      printProgress(
        `[skill] ${TARGET_LABELS[t]}: ${result.reason ?? result.action}.${
          tip ? " " + tip : ""
        }`,
      );
    }
  }

  printJson({
    dry_run: dryRun,
    target: selector,
    installed: installed as unknown as Record<string, unknown>[],
  });
}

export async function skillUninstallCommand(
  opts: SkillUninstallOptions = {},
): Promise<void> {
  const root = opts.skillRoot ?? findBundledSkillRoot();
  const defaults = defaultTargetPaths();
  const claudePath = opts.claudePath ?? defaults.claude;
  const codexPath = opts.codexPath ?? defaults.codex;
  const cursorPath = opts.cursorPath ?? defaults.cursor;

  const paths: Record<SkillTarget, string> = {
    claude: claudePath,
    codex: codexPath,
    cursor: cursorPath,
  };

  if (opts.printPaths) {
    printJson({ paths });
    return;
  }

  const selector: SkillTargetSelector = opts.target ?? "all";
  const targets = selectTargets(selector);
  const dryRun = Boolean(opts.dryRun);
  const yes = Boolean(opts.yes);

  const uninstalled: UninstallResult[] = [];
  for (const t of targets) {
    const destPath = paths[t];
    if (!existsSync(destPath)) {
      uninstalled.push({ target: t, path: destPath, action: "not-installed" });
      continue;
    }
    let source: string;
    try {
      source = readSource(root, t);
    } catch (err) {
      printError(err);
      return;
    }
    const result = uninstallOne(t, source, destPath, yes, dryRun);
    uninstalled.push(result);
    if (result.action === "needs-confirm") {
      printProgress(
        `[skill] ${TARGET_LABELS[t]}: ${result.reason}. Re-run with --yes to remove.`,
      );
    }
  }

  printJson({
    dry_run: dryRun,
    target: selector,
    uninstalled: uninstalled as unknown as Record<string, unknown>[],
  });
}
