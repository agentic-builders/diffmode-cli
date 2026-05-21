import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildProgram } from "../src/bin";
import { buildCommandsManifest } from "../src/commands/commands";

const DOC_PATH = resolve(
  __dirname,
  "..",
  "skills",
  "diffmode",
  "references",
  "commands.md",
);

// Extract documented leaf-command names from the headings in commands.md.
// We match `### \`diffmode <name>\`` so renames in either direction fail the
// drift check. The same heading is the canonical place where each command is
// introduced, so a missing entry here is a real docs gap.
function extractDocumentedCommands(md: string): string[] {
  const out: string[] = [];
  // Matches headings like `### \`diffmode jobs watch <job_id>\`` — capture
  // the name portion (after `diffmode`, before any optional `<arg>` token).
  const re = /^###\s+`diffmode\s+([a-z][a-z0-9 -]*?)(?:\s+<[^`]+)?`/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(md)) !== null) {
    const name = match[1]?.trim();
    if (name && name.length > 0) out.push(name);
  }
  return out;
}

// Manifest commands whose docs entry lives under a different heading shape
// than the `### \`diffmode <name>\`` form (e.g., `--version` is described in
// the JSON-envelope section, not as a leaf-command heading). Add an entry
// here only when the command is named in commands.md in some other
// recognisable form.
const DOC_EXEMPT_MANIFEST_COMMANDS = new Set<string>([]);

describe("references/commands.md drift check", () => {
  it("every documented command name appears in `diffmode commands --json` manifest", () => {
    const md = readFileSync(DOC_PATH, "utf8");
    const documented = extractDocumentedCommands(md);
    expect(documented.length).toBeGreaterThan(0);

    const manifest = buildCommandsManifest(buildProgram());
    const manifestNames = new Set(manifest.commands.map((c) => c.name));

    const missing = documented.filter((name) => !manifestNames.has(name));
    if (missing.length > 0) {
      throw new Error(
        `Commands documented in commands.md but missing from the CLI manifest:\n  - ${missing.join("\n  - ")}\n\n` +
          "Either implement the missing command(s) or remove them from references/commands.md.",
      );
    }
    expect(missing).toEqual([]);
  });

  it("every manifest leaf command appears in references/commands.md", () => {
    const md = readFileSync(DOC_PATH, "utf8");
    const documented = new Set(extractDocumentedCommands(md));

    const manifest = buildCommandsManifest(buildProgram());
    const undocumented = manifest.commands
      .map((c) => c.name)
      .filter(
        (name) => !documented.has(name) && !DOC_EXEMPT_MANIFEST_COMMANDS.has(name),
      );

    if (undocumented.length > 0) {
      throw new Error(
        `CLI manifest exposes commands missing from references/commands.md:\n  - ${undocumented.join("\n  - ")}\n\n` +
          "Add a `### \\`diffmode <name>\\`` heading to commands.md, or add the command to DOC_EXEMPT_MANIFEST_COMMANDS with a comment explaining the alternate doc location.",
      );
    }
    expect(undocumented).toEqual([]);
  });

  it("captures the canonical leaf commands (`run`, `jobs watch`, `billing balance`)", () => {
    const md = readFileSync(DOC_PATH, "utf8");
    const documented = extractDocumentedCommands(md);
    // Smoke-test the extractor itself so a regex regression fails loudly
    // here, not just in the superset check above.
    expect(documented).toContain("run");
    expect(documented).toContain("jobs watch");
    expect(documented).toContain("billing balance");
    expect(documented).toContain("commands");
  });
});
