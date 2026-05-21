import type { Argument, Command, Option } from "commander";
import { printJson, SCHEMA_VERSION } from "../lib/output";

// Per-command documented exit codes. Spec §8 lists the full code table; this
// map pins which codes each command can actually emit so agents know what to
// branch on. Update alongside per-command behavior (the drift-check in Task 8
// keeps this honest against references/error-codes.md).
const EXIT_CODES_BY_COMMAND: Record<string, number[]> = {
  // submit commands (POST → 202, plus 402/409/429)
  run: [0, 1, 2, 3, 4, 5, 7, 8, 9],
  workflow: [0, 1, 2, 3, 4, 5, 7, 8, 9],
  unlock: [0, 1, 2, 3, 4, 5, 7, 8, 9],
  "idea-eval": [0, 1, 2, 3, 4, 5, 7, 8, 9],
  "smoke-test": [0, 1, 2, 3, 4, 5, 7, 8, 9],

  // jobs sub-tree
  "jobs list": [0, 1, 3, 4, 9],
  "jobs status": [0, 1, 3, 4, 6, 9],
  "jobs watch": [0, 1, 3, 4, 6, 7, 9, 10, 130],
  "jobs resume": [0, 1, 2, 3, 4, 6, 9],
  "jobs cancel": [0, 1, 2, 3, 4, 6, 9],

  // results
  results: [0, 1, 2, 3, 4, 6, 9],

  // billing read-only
  account: [0, 1, 3, 4, 9],
  "billing balance": [0, 1, 3, 4, 9],
  "billing history": [0, 1, 3, 4, 9],
  limits: [0, 1, 3, 4, 9],

  // auth
  login: [0, 1, 2, 3, 4, 9],
  logout: [0],
  whoami: [0, 1, 3, 4, 9],

  // diagnostics helpers
  "diagnostics from-url": [0, 1, 2, 3, 4, 9],
  "diagnostics validate": [0, 1, 2],

  // self-describing
  commands: [0],

  // skill installer (Task 10)
  "skill show": [0, 1],
  "skill install": [0, 1, 2],
};

export interface ManifestArg {
  name: string;
  required: boolean;
  variadic?: boolean;
}

export interface ManifestOption {
  flag: string;
  type: "boolean" | "string";
  default?: unknown;
}

export interface ManifestEntry {
  name: string;
  summary: string;
  args: ManifestArg[];
  options: ManifestOption[];
  exits: number[];
}

export interface CommandsManifest {
  schema_version: string;
  version: string;
  globals: ManifestOption[];
  commands: ManifestEntry[];
}

function classifyOption(opt: Option): "boolean" | "string" {
  // Options with `<arg>` (required value) or `[arg]` (optional value) are
  // string-typed; bare flags and `--no-*` negate flags are boolean.
  if (opt.required) return "string";
  if (opt.optional) return "string";
  return "boolean";
}

function describeOption(opt: Option): ManifestOption {
  const out: ManifestOption = {
    flag: opt.long ?? opt.flags,
    type: classifyOption(opt),
  };
  // Emit `default` only when explicitly set and meaningful — skip the implicit
  // `false` that commander assigns to bare boolean flags.
  if (
    opt.defaultValue !== undefined &&
    !(typeof opt.defaultValue === "boolean" && opt.defaultValue === false)
  ) {
    out.default = opt.defaultValue;
  }
  return out;
}

function describeArg(arg: Argument): ManifestArg {
  const out: ManifestArg = {
    name: arg.name(),
    required: arg.required,
  };
  if (arg.variadic) out.variadic = true;
  return out;
}

function isParentCommand(cmd: Command): boolean {
  const subs = (cmd.commands ?? []).filter(
    (sub) => sub.name() !== "help" && !sub.name().startsWith("__"),
  );
  return subs.length > 0;
}

function walkCommandsFlat(
  cmd: Command,
  prefix: string[],
  out: ManifestEntry[],
): void {
  const fullName = [...prefix, cmd.name()].join(" ");
  const subs = (cmd.commands ?? []).filter(
    (sub) => sub.name() !== "help" && !sub.name().startsWith("__"),
  );

  if (!isParentCommand(cmd)) {
    out.push({
      name: fullName,
      summary: cmd.description() ?? "",
      args: (cmd.registeredArguments ?? []).map(describeArg),
      options: cmd.options.map(describeOption),
      exits: EXIT_CODES_BY_COMMAND[fullName] ?? [],
    });
  }

  for (const sub of subs) {
    walkCommandsFlat(sub, [...prefix, cmd.name()], out);
  }
}

export function buildCommandsManifest(program: Command): CommandsManifest {
  const commands: ManifestEntry[] = [];
  const topLevel = (program.commands ?? []).filter(
    (c) => c.name() !== "help" && !c.name().startsWith("__"),
  );
  for (const cmd of topLevel) {
    walkCommandsFlat(cmd, [], commands);
  }

  const globals: ManifestOption[] = program.options.map(describeOption);

  return {
    schema_version: SCHEMA_VERSION,
    version: program.version() ?? "",
    globals,
    commands,
  };
}

export function commandsCommand(program: Command): void {
  const manifest = buildCommandsManifest(program);
  printJson(manifest as unknown as Record<string, unknown>);
}
