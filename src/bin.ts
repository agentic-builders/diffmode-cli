import { Command, Option, InvalidArgumentError } from "commander";
import { printJson, printError, setOutputConfig } from "./lib/output";
import {
  loginCommand,
  logoutCommand,
  whoamiCommand,
  readTokenFromStdin,
} from "./commands/auth";
import {
  diagnosticsFromUrlCommand,
  diagnosticsValidateCommand,
} from "./commands/diagnostics";
import { DEFAULT_API_BASE } from "./lib/http";
import { resolveToken } from "./lib/token";
import { createCredentialStore } from "./lib/credentials";
import { runCommand } from "./commands/run";
import { unlockCommand } from "./commands/unlock";
import { workflowCommand } from "./commands/workflow";
import { ideaEvalCommand } from "./commands/idea-eval";
import { smokeTestCommand } from "./commands/smoke-test";
import { jobsListCommand } from "./commands/jobs/list";
import { jobsStatusCommand } from "./commands/jobs/status";
import { jobsWatchCommand } from "./commands/jobs/watch";
import { jobsResumeCommand } from "./commands/jobs/resume";
import { jobsCancelCommand } from "./commands/jobs/cancel";
import { resultsCommand } from "./commands/results";
import { accountCommand } from "./commands/account";
import { billingBalanceCommand } from "./commands/billing/balance";
import { billingHistoryCommand } from "./commands/billing/history";
import { limitsCommand } from "./commands/limits";
import { commandsCommand } from "./commands/commands";
import {
  skillShowCommand,
  skillInstallCommand,
  type SkillTargetSelector,
} from "./commands/skill";

const VERSION = "0.1.0";

interface GlobalOpts {
  json?: boolean;
  // Commander materialises `--no-color` as `color: false` (the negate-flag
  // convention). When the user does not pass the flag, `color` is `undefined`.
  color?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  yes?: boolean;
  token?: string;
  profile?: string;
  timeout?: number;
}

function resolveApiBase(): string {
  const fromEnv = process.env["DIFFMODE_API_BASE"];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return DEFAULT_API_BASE;
}

function resolveProfile(globals: GlobalOpts): string {
  if (globals.profile && globals.profile.length > 0) return globals.profile;
  const fromEnv = process.env["DIFFMODE_PROFILE"];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return "default";
}

function timeoutMs(globals: GlobalOpts): number {
  const seconds = typeof globals.timeout === "number" ? globals.timeout : 60;
  return seconds * 1000;
}

function parsePositiveInt(flag: string): (v: string) => number {
  return (v: string) => {
    const n = Number.parseInt(v, 10);
    if (!Number.isFinite(n) || n <= 0) {
      throw new InvalidArgumentError(`${flag} must be a positive integer.`);
    }
    return n;
  };
}

function parseNonNegativeInt(flag: string): (v: string) => number {
  return (v: string) => {
    const n = Number.parseInt(v, 10);
    if (!Number.isFinite(n) || n < 0) {
      throw new InvalidArgumentError(`${flag} must be a non-negative integer.`);
    }
    return n;
  };
}

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("diffmode")
    .description("Agent-drivable CLI for the Diffmode growth pipeline")
    .version(VERSION, "-v, --version", "Print version")
    .helpOption("-h, --help", "Display help")
    .addOption(
      new Option(
        "--json",
        "Emit machine-readable JSON (forces JSON even when stdout is a TTY)",
      ),
    )
    .addOption(new Option("--no-color", "Disable ANSI colors in output"))
    .addOption(new Option("--quiet", "Suppress progress output on stderr"))
    .addOption(new Option("--verbose", "Verbose output on stderr"))
    .addOption(
      new Option(
        "--yes",
        "Auto-confirm interactive prompts (non-destructive defaults)",
      ),
    )
    .addOption(
      new Option(
        "--token <pat>",
        "Personal access token (overrides DIFFMODE_TOKEN env + stored credential)",
      ),
    )
    .addOption(
      new Option(
        "--profile <name>",
        "Configuration profile (falls back to DIFFMODE_PROFILE env, then 'default')",
      ),
    )
    .addOption(
      new Option(
        "--timeout <seconds>",
        "Per-HTTP-request timeout in seconds (default 60)",
      )
        .argParser(parsePositiveInt("--timeout"))
        .default(60),
    );

  // Intercept --version when --json is set: emit a richer envelope.
  program.exitOverride();

  program.hook("preAction", (thisCommand) => {
    applyGlobals(thisCommand.optsWithGlobals() as GlobalOpts);
  });

  // Help footer for agents (printed only on TTY for help output).
  program.addHelpText("after", () => {
    if (!process.stdout.isTTY) return "";
    return (
      "\nFor agents: pass --json on any command for machine-readable output.\n" +
      "Exit codes documented at https://github.com/agentic-builders/diffmode-cli#exit-codes."
    );
  });

  registerAuthCommands(program);
  registerDiagnosticsCommands(program);
  registerSubmitCommands(program);
  registerJobsCommands(program);
  registerResultsCommand(program);
  registerBillingCommands(program);
  registerSelfDescribingCommands(program);
  registerSkillCommands(program);

  return program;
}

function registerSkillCommands(program: Command): void {
  const skill = program
    .command("skill")
    .description(
      "Show or install the bundled diffmode SKILL.md / Cursor MDC for agent tools.",
    );

  skill
    .command("show")
    .description("Print the bundled SKILL.md (`{path, contents}` on --json).")
    .action(async () => {
      try {
        await skillShowCommand({});
      } catch (err) {
        printError(err);
      }
    });

  skill
    .command("install")
    .description(
      "Install the bundled skill into Claude/Codex/Cursor agent dirs.",
    )
    .option(
      "--target <name>",
      "Which agent to install for: claude | codex | cursor | all",
      "all",
    )
    .option("--yes", "Overwrite existing files when content differs.")
    .option("--dry-run", "Report what would happen without writing.")
    .option("--print-paths", "Print the resolved paths and exit.")
    .action(
      async (cmdOpts: {
        target?: string;
        yes?: boolean;
        dryRun?: boolean;
        printPaths?: boolean;
      }) => {
        const target = (cmdOpts.target ?? "all") as SkillTargetSelector;
        if (
          target !== "all" &&
          target !== "claude" &&
          target !== "codex" &&
          target !== "cursor"
        ) {
          printError(
            new Error(
              `Unknown --target ${target}. Use one of: claude, codex, cursor, all.`,
            ),
          );
          return;
        }
        try {
          await skillInstallCommand({
            target,
            yes: Boolean(cmdOpts.yes),
            dryRun: Boolean(cmdOpts.dryRun),
            printPaths: Boolean(cmdOpts.printPaths),
            ...envOverrideTargetPaths(),
          });
        } catch (err) {
          printError(err);
        }
      },
    );
}

function envOverrideTargetPaths(): {
  claudePath?: string;
  codexPath?: string;
  cursorPath?: string;
} {
  const out: { claudePath?: string; codexPath?: string; cursorPath?: string } =
    {};
  const claude = process.env["DIFFMODE_SKILL_CLAUDE_PATH"];
  const codex = process.env["DIFFMODE_SKILL_CODEX_PATH"];
  const cursor = process.env["DIFFMODE_SKILL_CURSOR_PATH"];
  if (claude && claude.length > 0) out.claudePath = claude;
  if (codex && codex.length > 0) out.codexPath = codex;
  if (cursor && cursor.length > 0) out.cursorPath = cursor;
  return out;
}

function registerSelfDescribingCommands(program: Command): void {
  program
    .command("commands")
    .description(
      "Emit a machine-readable manifest of the CLI tree (agent self-discovery).",
    )
    .action(() => {
      commandsCommand(program);
    });
}

function registerBillingCommands(program: Command): void {
  program
    .command("account")
    .description("Show the active token's credit balance + purchase status.")
    .action(async () => {
      const globals = program.optsWithGlobals() as GlobalOpts;
      try {
        const token = await resolveActiveToken(globals);
        await accountCommand({
          apiBase: resolveApiBase(),
          ...(token ? { token } : {}),
          timeoutMs: timeoutMs(globals),
        });
      } catch (err) {
        printError(err);
      }
    });

  const billing = program
    .command("billing")
    .description(
      "Billing surface (read-only). Top-up is browser-only by design — see `diffmode limits`.",
    );

  billing
    .command("balance")
    .description("Terse credit balance (JSON).")
    .action(async () => {
      const globals = program.optsWithGlobals() as GlobalOpts;
      try {
        const token = await resolveActiveToken(globals);
        await billingBalanceCommand({
          apiBase: resolveApiBase(),
          ...(token ? { token } : {}),
          timeoutMs: timeoutMs(globals),
        });
      } catch (err) {
        printError(err);
      }
    });

  billing
    .command("history")
    .description(
      "Paginated credit transactions (NDJSON; offset/limit, not B5 keyset).",
    )
    .option(
      "--limit <n>",
      "Page size (max 100; default 50)",
      parsePositiveInt("--limit"),
    )
    .option(
      "--offset <n>",
      "Number of transactions to skip (offset-based pagination)",
      parseNonNegativeInt("--offset"),
    )
    .action(async (cmdOpts: { limit?: number; offset?: number }) => {
      const globals = program.optsWithGlobals() as GlobalOpts;
      try {
        const token = await resolveActiveToken(globals);
        await billingHistoryCommand({
          apiBase: resolveApiBase(),
          ...(token ? { token } : {}),
          timeoutMs: timeoutMs(globals),
          ...(cmdOpts.limit !== undefined ? { limit: cmdOpts.limit } : {}),
          ...(cmdOpts.offset !== undefined ? { offset: cmdOpts.offset } : {}),
          isTTY: Boolean(process.stdout.isTTY),
        });
      } catch (err) {
        printError(err);
      }
    });

  // Intentionally NO `billing topup` command. Top-up is browser-only by design;
  // attempting it should print the standard "unknown command" usage error.

  program
    .command("limits")
    .description("Show credit availability + documented rate-limit policy.")
    .action(async () => {
      const globals = program.optsWithGlobals() as GlobalOpts;
      try {
        const token = await resolveActiveToken(globals);
        await limitsCommand({
          apiBase: resolveApiBase(),
          ...(token ? { token } : {}),
          timeoutMs: timeoutMs(globals),
        });
      } catch (err) {
        printError(err);
      }
    });
}

function registerResultsCommand(program: Command): void {
  program
    .command("results <product>")
    .description(
      "Download a product's outputs and emit a manifest (Phase 1: report.json + raw outputs).",
    )
    .option("--job-id <id>", "Pin to a specific completed job_id")
    .option("--out <dir>", "Override the default output directory")
    .option("--summary", "Print only the report's keyFinding sections")
    .option("--show <path>", "Cat a single downloaded file to stdout")
    .option(
      "--max-tokens <n>",
      "Truncate --show output to ~N tokens",
      parsePositiveInt("--max-tokens"),
    )
    .option("--pull", "Download silently with no manifest output")
    .option("--stage <s>", "Free-tier only: extract a single report section")
    .option(
      "--tactic <t>",
      "Free-tier only: extract a single growthPlan tactic",
    )
    .action(
      async (
        product: string,
        cmdOpts: {
          jobId?: string;
          out?: string;
          summary?: boolean;
          show?: string;
          maxTokens?: number;
          pull?: boolean;
          stage?: string;
          tactic?: string;
        },
      ) => {
        const globals = program.optsWithGlobals() as GlobalOpts;
        try {
          const token = await resolveActiveToken(globals);
          await resultsCommand({
            product,
            apiBase: resolveApiBase(),
            ...(token ? { token } : {}),
            timeoutMs: timeoutMs(globals),
            ...(cmdOpts.jobId !== undefined ? { jobId: cmdOpts.jobId } : {}),
            ...(cmdOpts.out !== undefined ? { out: cmdOpts.out } : {}),
            ...(cmdOpts.summary !== undefined
              ? { summary: cmdOpts.summary }
              : {}),
            ...(cmdOpts.show !== undefined ? { show: cmdOpts.show } : {}),
            ...(cmdOpts.maxTokens !== undefined
              ? { maxTokens: cmdOpts.maxTokens }
              : {}),
            ...(cmdOpts.pull !== undefined ? { pull: cmdOpts.pull } : {}),
            ...(cmdOpts.stage !== undefined ? { stage: cmdOpts.stage } : {}),
            ...(cmdOpts.tactic !== undefined ? { tactic: cmdOpts.tactic } : {}),
          });
        } catch (err) {
          printError(err);
        }
      },
    );
}

interface SubmitOptionFlags {
  input?: string;
  fromUrl?: string;
  saveInput?: string;
  idempotencyKey?: string;
  // Commander materializes `--no-preflight` as `preflight: false`; we also
  // accept a direct `noPreflight: true` from the consolidated picker.
  preflight?: boolean;
  noPreflight?: boolean;
}

function pickSubmitOptions(
  globals: GlobalOpts,
  flags: SubmitOptionFlags,
  resolvedToken: string | null,
): {
  apiBase: string;
  token?: string;
  inputPath?: string;
  fromUrl?: string;
  saveInputPath?: string;
  idempotencyKey?: string;
  timeoutMs: number;
  verbose: boolean;
  quiet: boolean;
  noPreflight: boolean;
} {
  const out: {
    apiBase: string;
    token?: string;
    inputPath?: string;
    fromUrl?: string;
    saveInputPath?: string;
    idempotencyKey?: string;
    timeoutMs: number;
    verbose: boolean;
    quiet: boolean;
    noPreflight: boolean;
  } = {
    apiBase: resolveApiBase(),
    timeoutMs: timeoutMs(globals),
    verbose: Boolean(globals.verbose),
    quiet: Boolean(globals.quiet),
    noPreflight: flags.preflight === false || Boolean(flags.noPreflight),
  };
  if (resolvedToken) out.token = resolvedToken;
  if (flags.input !== undefined) out.inputPath = flags.input;
  if (flags.fromUrl !== undefined) out.fromUrl = flags.fromUrl;
  if (flags.saveInput !== undefined) out.saveInputPath = flags.saveInput;
  if (flags.idempotencyKey !== undefined)
    out.idempotencyKey = flags.idempotencyKey;
  return out;
}

function registerSubmitCommands(program: Command): void {
  program
    .command("run <product>")
    .description(
      "Run the Diffmode free-tier diagnostic (1 credit). Default verb for new users.",
    )
    .option("--input <file>", "Founder-input JSON file (use `-` for stdin)")
    .option(
      "--from-url <url>",
      "Pre-fill founder input by analyzing a public URL",
    )
    .option(
      "--save-input <path>",
      "Persist the resolved founder-input to this path",
    )
    .option(
      "--idempotency-key <uuid>",
      "Optional idempotency key. Omit to skip the header (no auto-gen).",
    )
    .option(
      "--no-preflight",
      "Skip the local credit pre-flight check (let the server reject).",
    )
    .action(async (product: string, cmdOpts: SubmitOptionFlags) => {
      const globals = program.optsWithGlobals() as GlobalOpts;
      try {
        const token = await resolveActiveToken(globals);
        await runCommand({
          product,
          ...pickSubmitOptions(globals, cmdOpts, token),
        });
      } catch (err) {
        printError(err);
      }
    });

  program
    .command("workflow <product>")
    .description(
      "Run the full Diffmode workflow (15 credits). Requires founder input.",
    )
    .option("--input <file>", "Founder-input JSON file (use `-` for stdin)")
    .option(
      "--from-url <url>",
      "Pre-fill founder input by analyzing a public URL",
    )
    .option(
      "--save-input <path>",
      "Persist the resolved founder-input to this path",
    )
    .option("--idempotency-key <uuid>", "Optional idempotency key.")
    .option(
      "--no-preflight",
      "Skip the local credit pre-flight check (let the server reject).",
    )
    .action(async (product: string, cmdOpts: SubmitOptionFlags) => {
      const globals = program.optsWithGlobals() as GlobalOpts;
      try {
        const token = await resolveActiveToken(globals);
        await workflowCommand({
          product,
          ...pickSubmitOptions(globals, cmdOpts, token),
        });
      } catch (err) {
        printError(err);
      }
    });

  program
    .command("unlock <product>")
    .description(
      "Unlock the full Diffmode report (15 credits). Requires a completed `diffmode run` first.",
    )
    .option("--idempotency-key <uuid>", "Optional idempotency key.")
    .option(
      "--no-preflight",
      "Skip the local credit pre-flight check (let the server reject).",
    )
    .action(
      async (
        product: string,
        cmdOpts: { idempotencyKey?: string; preflight?: boolean },
      ) => {
        const globals = program.optsWithGlobals() as GlobalOpts;
        try {
          const token = await resolveActiveToken(globals);
          const opts = pickSubmitOptions(
            globals,
            {
              ...(cmdOpts.idempotencyKey !== undefined
                ? { idempotencyKey: cmdOpts.idempotencyKey }
                : {}),
              noPreflight: cmdOpts.preflight === false,
            },
            token,
          );
          await unlockCommand({
            product,
            apiBase: opts.apiBase,
            ...(opts.token !== undefined ? { token: opts.token } : {}),
            timeoutMs: opts.timeoutMs,
            ...(opts.idempotencyKey !== undefined
              ? { idempotencyKey: opts.idempotencyKey }
              : {}),
            verbose: opts.verbose,
            noPreflight: opts.noPreflight,
          });
        } catch (err) {
          printError(err);
        }
      },
    );

  program
    .command("idea-eval <product>")
    .description(
      "Evaluate a list of ideas against your founder context (5 credits).",
    )
    .requiredOption(
      "--ideas-file <path>",
      "JSON file containing an array of IdeaInput objects",
    )
    .option("--intuition <text>", "Founder's qualitative intuition")
    .option("--target-idea <slug>", "Evaluate only one idea by slug")
    .option("--idempotency-key <uuid>", "Optional idempotency key.")
    .option(
      "--no-preflight",
      "Skip the local credit pre-flight check (let the server reject).",
    )
    .action(
      async (
        product: string,
        cmdOpts: {
          ideasFile: string;
          intuition?: string;
          targetIdea?: string;
          idempotencyKey?: string;
          preflight?: boolean;
        },
      ) => {
        const globals = program.optsWithGlobals() as GlobalOpts;
        try {
          const token = await resolveActiveToken(globals);
          await ideaEvalCommand({
            product,
            apiBase: resolveApiBase(),
            ...(token ? { token } : {}),
            ideasFile: cmdOpts.ideasFile,
            ...(cmdOpts.intuition !== undefined
              ? { intuition: cmdOpts.intuition }
              : {}),
            ...(cmdOpts.targetIdea !== undefined
              ? { targetIdea: cmdOpts.targetIdea }
              : {}),
            ...(cmdOpts.idempotencyKey !== undefined
              ? { idempotencyKey: cmdOpts.idempotencyKey }
              : {}),
            timeoutMs: timeoutMs(globals),
            verbose: Boolean(globals.verbose),
            noPreflight: cmdOpts.preflight === false,
          });
        } catch (err) {
          printError(err);
        }
      },
    );

  program
    .command("smoke-test <product>")
    .description(
      "Quick smoke-test of one growth tactic (1 credit). Always pass founder input.",
    )
    .option("--input <file>", "Founder-input JSON file (use `-` for stdin)")
    .option(
      "--from-url <url>",
      "Pre-fill founder input by analyzing a public URL",
    )
    .option(
      "--save-input <path>",
      "Persist the resolved founder-input to this path",
    )
    .option("--idempotency-key <uuid>", "Optional idempotency key.")
    .option(
      "--no-preflight",
      "Skip the local credit pre-flight check (let the server reject).",
    )
    .action(async (product: string, cmdOpts: SubmitOptionFlags) => {
      const globals = program.optsWithGlobals() as GlobalOpts;
      try {
        const token = await resolveActiveToken(globals);
        await smokeTestCommand({
          product,
          ...pickSubmitOptions(globals, cmdOpts, token),
        });
      } catch (err) {
        printError(err);
      }
    });
}

function parseDurationMs(input: string): number {
  // Accepts: `30s`, `4m`, `2h`, or a bare number-of-seconds.
  const m = input.match(/^(\d+)(s|m|h)?$/);
  if (!m) {
    throw new InvalidArgumentError(
      `Invalid duration: ${input}. Use 30s, 4m, or 2h.`,
    );
  }
  const n = Number.parseInt(m[1]!, 10);
  const unit = m[2] ?? "s";
  if (unit === "s") return n * 1000;
  if (unit === "m") return n * 60 * 1000;
  return n * 60 * 60 * 1000;
}

function registerJobsCommands(program: Command): void {
  const jobs = program
    .command("jobs")
    .description("Inspect, watch, resume, and cancel Diffmode jobs.");

  jobs
    .command("list")
    .description("List recent jobs (NDJSON on --json or non-TTY).")
    .option("--product <id>", "Filter by product_id")
    .option("--status <s>", "Filter by status")
    .option(
      "--limit <n>",
      "Page size (max 200; default 50)",
      parsePositiveInt("--limit"),
    )
    .option(
      "--cursor <c>",
      "Keyset pagination cursor (from a prior `next_cursor`)",
    )
    .action(
      async (cmdOpts: {
        product?: string;
        status?: string;
        limit?: number;
        cursor?: string;
      }) => {
        const globals = program.optsWithGlobals() as GlobalOpts;
        try {
          const token = await resolveActiveToken(globals);
          await jobsListCommand({
            apiBase: resolveApiBase(),
            ...(token ? { token } : {}),
            ...(cmdOpts.product !== undefined
              ? { product: cmdOpts.product }
              : {}),
            ...(cmdOpts.status !== undefined ? { status: cmdOpts.status } : {}),
            ...(cmdOpts.limit !== undefined ? { limit: cmdOpts.limit } : {}),
            ...(cmdOpts.cursor !== undefined ? { cursor: cmdOpts.cursor } : {}),
            timeoutMs: timeoutMs(globals),
            isTTY: Boolean(process.stdout.isTTY),
          });
        } catch (err) {
          printError(err);
        }
      },
    );

  jobs
    .command("status <job_id>")
    .description("Fetch a job's current status + progress.")
    .action(async (jobId: string) => {
      const globals = program.optsWithGlobals() as GlobalOpts;
      try {
        const token = await resolveActiveToken(globals);
        await jobsStatusCommand({
          jobId,
          apiBase: resolveApiBase(),
          ...(token ? { token } : {}),
          timeoutMs: timeoutMs(globals),
        });
      } catch (err) {
        printError(err);
      }
    });

  jobs
    .command("watch <job_id>")
    .description("Poll a job until terminal; progress on stderr.")
    .option(
      "--wait <duration>",
      "Total polling wait (e.g., 4h, 30m, 300s)",
      parseDurationMs,
    )
    .action(async (jobId: string, cmdOpts: { wait?: number }) => {
      const globals = program.optsWithGlobals() as GlobalOpts;
      try {
        const token = await resolveActiveToken(globals);
        await jobsWatchCommand({
          jobId,
          apiBase: resolveApiBase(),
          ...(token ? { token } : {}),
          timeoutMs: timeoutMs(globals),
          ...(cmdOpts.wait !== undefined
            ? { totalTimeoutMs: cmdOpts.wait }
            : {}),
          isTTY: Boolean(process.stderr.isTTY),
        });
      } catch (err) {
        printError(err);
      }
    });

  jobs
    .command("resume <job_id>")
    .description(
      "Resume an interrupted job. Module-branched (workflow + free-tier only).",
    )
    .option("--idempotency-key <uuid>", "Optional idempotency key.")
    .action(async (jobId: string, cmdOpts: { idempotencyKey?: string }) => {
      const globals = program.optsWithGlobals() as GlobalOpts;
      try {
        const token = await resolveActiveToken(globals);
        await jobsResumeCommand({
          jobId,
          apiBase: resolveApiBase(),
          ...(token ? { token } : {}),
          ...(cmdOpts.idempotencyKey !== undefined
            ? { idempotencyKey: cmdOpts.idempotencyKey }
            : {}),
          timeoutMs: timeoutMs(globals),
        });
      } catch (err) {
        printError(err);
      }
    });

  jobs
    .command("cancel <job_id>")
    .description("Cancel a running job (DELETE /jobs/{id}).")
    .action(async (jobId: string) => {
      const globals = program.optsWithGlobals() as GlobalOpts;
      try {
        const token = await resolveActiveToken(globals);
        await jobsCancelCommand({
          jobId,
          apiBase: resolveApiBase(),
          ...(token ? { token } : {}),
          timeoutMs: timeoutMs(globals),
          yes: Boolean(globals.yes),
        });
      } catch (err) {
        printError(err);
      }
    });
}

function registerDiagnosticsCommands(program: Command): void {
  const diagnostics = program
    .command("diagnostics")
    .description(
      "Founder-input helpers: pre-fill from a website URL or validate a JSON file.",
    );

  diagnostics
    .command("from-url <url>")
    .description(
      "Pre-fill founder diagnostics by analyzing a public URL. Prints (or saves) FounderDiagnostics JSON.",
    )
    .option("--save <path>", "Write the result to this file instead of stdout")
    .action(async (url: string, cmdOpts: { save?: string }) => {
      const globals = program.optsWithGlobals() as GlobalOpts;
      try {
        const token = await resolveActiveToken(globals);
        await diagnosticsFromUrlCommand({
          url,
          apiBase: resolveApiBase(),
          ...(token ? { token } : {}),
          ...(cmdOpts.save ? { save: cmdOpts.save } : {}),
          quiet: Boolean(globals.quiet),
          timeoutMs: timeoutMs(globals),
        });
      } catch (err) {
        printError(err);
      }
    });

  diagnostics
    .command("validate <path>")
    .description(
      "Validate a founder-input JSON file against the FounderDiagnostics schema.",
    )
    .action(async (path: string) => {
      try {
        await diagnosticsValidateCommand({ path });
      } catch (err) {
        printError(err);
      }
    });
}

async function resolveActiveToken(globals: GlobalOpts): Promise<string | null> {
  const store = createCredentialStore();
  return resolveToken({
    store,
    ...(globals.token !== undefined ? { cliToken: globals.token } : {}),
    profile: resolveProfile(globals),
  });
}

function registerAuthCommands(program: Command): void {
  program
    .command("login")
    .description(
      "Authenticate with a Diffmode personal access token (PAT). Reads from stdin or --token.",
    )
    .action(async () => {
      const globals = program.optsWithGlobals() as GlobalOpts;
      const cliToken = (globals.token ?? "").trim();
      const envToken = (process.env["DIFFMODE_TOKEN"] ?? "").trim();
      let token = cliToken.length > 0 ? cliToken : envToken;
      if (!token) {
        if (process.stdin.isTTY) {
          // We don't prompt interactively in 0.1.0; require pipe or --token.
          printError(
            new Error(
              "No token supplied. Pipe one in (`echo dm_pat_… | diffmode login`) or pass `--token dm_pat_…`.",
            ),
          );
          return;
        }
        token = (await readTokenFromStdin()).trim();
      }
      if (!token) {
        printError(new Error("No token supplied."));
        return;
      }
      const profile = resolveProfile(globals);
      try {
        await loginCommand({
          token,
          apiBase: resolveApiBase(),
          profile,
          timeoutMs: timeoutMs(globals),
        });
      } catch (err) {
        printError(err);
      }
    });

  program
    .command("logout")
    .description("Clear stored credentials for the active profile.")
    .action(async () => {
      const globals = program.optsWithGlobals() as GlobalOpts;
      try {
        await logoutCommand({
          profile: resolveProfile(globals),
        });
      } catch (err) {
        printError(err);
      }
    });

  program
    .command("whoami")
    .description("Verify the active token and print identity metadata.")
    .action(async () => {
      const globals = program.optsWithGlobals() as GlobalOpts;
      try {
        await whoamiCommand({
          apiBase: resolveApiBase(),
          profile: resolveProfile(globals),
          ...(globals.token !== undefined ? { cliToken: globals.token } : {}),
          timeoutMs: timeoutMs(globals),
        });
      } catch (err) {
        printError(err);
      }
    });
}

export function applyGlobals(opts: GlobalOpts): void {
  const envNoColor =
    typeof process.env["NO_COLOR"] === "string" &&
    process.env["NO_COLOR"].length > 0;
  setOutputConfig({
    json: Boolean(opts.json),
    quiet: Boolean(opts.quiet),
    verbose: Boolean(opts.verbose),
    noColor: opts.color === false || envNoColor,
    isTTY: Boolean(process.stdout.isTTY),
  });
}

export function getVersion(): string {
  return VERSION;
}

export function emitVersionJson(): void {
  printJson({
    version: VERSION,
    node: process.version,
    platform: process.platform,
  });
}

export async function main(argv: string[]): Promise<number> {
  const program = buildProgram();

  // Intercept the special `--version --json` pairing before commander's
  // built-in version handler (which always prints plain text).
  if (
    argv.includes("--json") &&
    (argv.includes("-v") || argv.includes("--version"))
  ) {
    emitVersionJson();
    return 0;
  }

  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (err) {
    if (isCommanderExitError(err)) {
      const code = (err as { exitCode?: number }).exitCode ?? 0;
      return code;
    }
    printError(err);
    return 1; // unreachable; printError exits
  }
}

function isCommanderExitError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof (err as { code?: unknown }).code === "string" &&
    String((err as { code?: unknown }).code).startsWith("commander.")
  );
}

if (require.main === module) {
  void main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
