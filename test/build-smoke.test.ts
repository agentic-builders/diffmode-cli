import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(__dirname, "..");
const binPath = resolve(repoRoot, "dist/bin.js");

function ensureBuilt(): void {
  if (!existsSync(binPath)) {
    execFileSync("npm", ["run", "build"], {
      cwd: repoRoot,
      stdio: "inherit",
    });
  }
}

describe("esbuild bundle smoke", () => {
  it("npm run build produces dist/bin.js", () => {
    ensureBuilt();
    expect(existsSync(binPath)).toBe(true);
    const stat = statSync(binPath);
    expect(stat.size).toBeGreaterThan(0);
  });

  it("dist/bin.js --version exits 0 and prints the version", () => {
    ensureBuilt();
    const result = spawnSync(process.execPath, [binPath, "--version"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("dist/bin.js --version --json emits schema_version:1", () => {
    ensureBuilt();
    const result = spawnSync(
      process.execPath,
      [binPath, "--version", "--json"],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.schema_version).toBe("1");
    expect(parsed.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
