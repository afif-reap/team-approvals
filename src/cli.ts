#!/usr/bin/env node
import { Command, CommanderError, Option } from "commander";
import { createRequire } from "node:module";
import { TeamApi, validateApproval } from "./api.js";
import { importRefreshToken, refreshSession, revokeSession } from "./auth.js";
import { configPath, defaultApprovalComment, getConfig } from "./config.js";
import { discoverTeamConfig, writeTeamConfig } from "./discovery.js";
import { asCliError, CliError } from "./errors.js";
import { readRefreshToken } from "./keychain.js";
import { printJson, printRequests, requestSummary } from "./output.js";
import { buildRequestDraft, RequestsApi } from "./requests.js";

const program = new Command();
const jsonRequested = process.argv.includes("--json");
const packageJson = createRequire(import.meta.url)("../package.json") as { version: string };

program
  .name("team-approvals")
  .description("Create and approve AWS TEAM elevated-access requests")
  .version(packageJson.version)
  .option("--json", "emit stable JSON to stdout");

function configureCommandOutput(command: Command): void {
  command.configureOutput({
    writeOut: (text) => {
      if (!jsonRequested) process.stdout.write(text);
    },
    writeErr: (text) => {
      if (!jsonRequested) process.stderr.write(text);
    },
    outputError: (text, write) => {
      if (!jsonRequested) write(text);
    },
  });
  for (const child of command.commands) configureCommandOutput(child);
}

program.exitOverride((error) => {
  if (error.exitCode === 0) process.exit(0);
  throw error;
});

program
  .command("init")
  .description("Discover public Amplify settings from a TEAM app and create the local config")
  .requiredOption("--app-url <url>", "TEAM web application URL")
  .option("--dry-run", "discover and validate without writing config")
  .option("--force", "replace an existing local config")
  .action(async (options: { appUrl: string; dryRun?: boolean; force?: boolean }) => {
    const discovered = await discoverTeamConfig(options.appUrl);
    if (!options.dryRun) writeTeamConfig(discovered, configPath, Boolean(options.force));
    const result = {
      written: !options.dryRun,
      path: configPath,
      config: discovered,
    };
    if (jsonRequested) printJson(result);
    else process.stdout.write(`${options.dryRun ? "Discovered" : "Created"} TEAM config at ${configPath}.\n`);
  });

program
  .command("doctor")
  .description("Check configuration, stored authentication, and endpoint reachability")
  .action(async () => {
    const config = getConfig();
    const refreshTokenStored = Boolean(await readRefreshToken());
    let authenticated = false;
    let endpointReachable = false;
    let email: string | null = null;
    let problem: { code: string; message: string } | null = null;
    if (refreshTokenStored) {
      try {
        const session = await refreshSession();
        email = session.email;
        authenticated = true;
        await new TeamApi(session.accessToken).check();
        endpointReachable = true;
      } catch (error) {
        const cliError = asCliError(error);
        problem = { code: cliError.code, message: cliError.message };
      }
    }
    const result = {
      ok: authenticated && endpointReachable,
      auth: {
        refresh_token_stored: refreshTokenStored,
        authenticated,
        email,
        source: refreshTokenStored ? "macos_keychain" : "missing",
        next_step: authenticated ? null : "team-approvals auth import",
      },
      api: { reachable: endpointReachable, problem },
      config: {
        path: configPath,
        app_url: config.appUrl,
        graphql_endpoint: config.graphQlEndpoint,
        cognito_domain: config.cognitoDomain,
        client_id: config.clientId,
      },
    };
    if (jsonRequested) printJson(result);
    else {
      process.stdout.write(
        `Configuration: OK\nAuthentication: ${authenticated ? email : "missing or expired"}\nTEAM API: ${endpointReachable ? "reachable" : "not checked or unreachable"}\n`,
      );
      if (!authenticated) process.stdout.write("Next: team-approvals auth import\n");
    }
    if (!result.ok) process.exitCode = 1;
  });

const auth = program.command("auth").description("Manage TEAM Cognito authentication");

function promptForRefreshToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    let token = "";
    const wasRaw = input.isRaw;
    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode?.(Boolean(wasRaw));
      input.pause();
      process.stderr.write("\n");
    };
    const finish = () => {
      cleanup();
      resolve(token);
    };
    const onData = (chunk: Buffer | string) => {
      for (const character of String(chunk)) {
        if (character === "\r" || character === "\n" || character === "\u0004") {
          finish();
          return;
        }
        if (character === "\u0003") {
          cleanup();
          reject(new CliError("Refresh-token import cancelled", "import_cancelled"));
          return;
        }
        if (character === "\u007f" || character === "\b") token = token.slice(0, -1);
        else token += character;
        if (token.length > 16_384) {
          cleanup();
          reject(new CliError("Refresh token input is too large", "invalid_refresh_token"));
          return;
        }
      }
    };
    process.stderr.write(
      [
        "In the logged-in TEAM tab, open DevTools Console and run:",
        "",
        "(() => {",
        "  const matches = Object.entries(localStorage).filter(",
        '    ([key, value]) => key.startsWith("CognitoIdentityServiceProvider.") &&',
        '      key.endsWith(".refreshToken") && value,',
        "  );",
        "  if (matches.length !== 1) throw new Error(`Expected one refresh token, found ${matches.length}`);",
        '  copy(matches[0][1]); return "Refresh token copied";',
        "})()",
        "",
        "Paste the refresh token here and press Enter (input hidden): ",
      ].join("\n"),
    );
    input.setEncoding("utf8");
    input.setRawMode?.(true);
    input.resume();
    input.on("data", onData);
  });
}

const requests = program.command("requests").description("Discover eligible access and create TEAM requests");

requests
  .command("options")
  .description("List account and role combinations eligible for the authenticated user")
  .action(async () => {
    const session = await refreshSession();
    const api = new RequestsApi(session);
    const [options, settings] = await Promise.all([api.getOptions(), api.getSettings()]);
    printJson({ options, settings });
  });

requests
  .command("create")
  .description("Create one temporary elevated-access request")
  .requiredOption("--account <id-or-name>", "eligible AWS account ID or exact name")
  .requiredOption("--role <arn-or-name>", "eligible permission-set ARN or exact name")
  .requiredOption("--duration <hours>", "requested duration in hours", Number)
  .requiredOption("--justification <text>", "business justification")
  .option("--ticket <number>", "change-management ticket number")
  .option("--start-time <iso-date>", "ISO date-time; defaults to now")
  .option("--dry-run", "validate and show the request without creating it")
  .action(
    async (options: {
      account: string;
      role: string;
      duration: number;
      justification: string;
      ticket?: string;
      startTime?: string;
      dryRun?: boolean;
    }) => {
      const session = await refreshSession();
      const api = new RequestsApi(session);
      const [eligibleOptions, settings] = await Promise.all([api.getOptions(), api.getSettings()]);
      const draft = buildRequestDraft(eligibleOptions, settings, options);
      if (draft.approvalRequired) await api.assertApproverAvailable(draft.input.accountId);
      if (options.dryRun) {
        printJson({ dry_run: true, action: "create_request", approval_required: draft.approvalRequired, request: draft.input });
        return;
      }
      const created = await api.create(draft.input);
      if (jsonRequested) printJson({ created: true, request: created });
      else process.stdout.write(`Created TEAM request ${created.id} (${created.accountName} / ${created.role}).\n`);
    },
  );

auth
  .command("import")
  .description("Prompt for, validate, and save a Cognito refresh token")
  .action(async () => {
    if (!process.stdin.isTTY) throw new CliError("Authentication import requires an interactive terminal", "tty_required");
    const input = await promptForRefreshToken();
    const session = await importRefreshToken(input);
    const result = { authenticated: true, email: session.email, expires_at: session.expiresAt };
    if (jsonRequested) printJson(result);
    else process.stdout.write(`Imported TEAM authentication for ${session.email}.\n`);
  });

auth
  .command("status")
  .description("Refresh the Cognito session and print the authenticated identity")
  .action(async () => {
    const session = await refreshSession();
    const result = { authenticated: true, email: session.email, expires_at: session.expiresAt };
    if (jsonRequested) printJson(result);
    else process.stdout.write(`Authenticated as ${session.email}; token valid until ${session.expiresAt}.\n`);
  });

auth
  .command("logout")
  .description("Revoke and delete saved TEAM authentication")
  .action(async () => {
    const deleted = await revokeSession();
    if (jsonRequested) printJson({ authenticated: false, token_deleted: deleted });
    else process.stdout.write(deleted ? "TEAM authentication deleted.\n" : "No TEAM authentication was stored.\n");
  });

const approvals = program.command("approvals").description("List, inspect, and approve TEAM requests");

approvals
  .command("list")
  .description("List pending requests assigned to the authenticated approver")
  .addOption(new Option("--limit <number>", "maximum requests to return").default(20).argParser(Number))
  .action(async (options: { limit: number }) => {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
      throw new CliError("--limit must be an integer from 1 to 100", "invalid_limit");
    }
    const session = await refreshSession();
    const requests = await new TeamApi(session.accessToken).listPending(session.email, options.limit);
    if (jsonRequested) printJson({ requests: requests.map(requestSummary), count: requests.length });
    else printRequests(requests);
  });

approvals
  .command("get")
  .description("Get one TEAM request by ID")
  .argument("<request-id>", "TEAM request ID")
  .action(async (requestId: string) => {
    const session = await refreshSession();
    const request = await new TeamApi(session.accessToken).getRequest(requestId);
    if (!request) throw new CliError(`Request ${requestId} was not found or is not visible to you`, "request_not_found");
    printJson(requestSummary(request));
  });

approvals
  .command("approve")
  .description("Approve one pending TEAM request")
  .argument("<request-id>", "TEAM request ID")
  .option("--comment <message>", "approval comment", defaultApprovalComment)
  .option("--dry-run", "validate and show the approval without changing TEAM")
  .action(async (requestId: string, options: { comment: string; dryRun?: boolean }) => {
    if (!/[\p{L}\p{N}]/u.test(options.comment[0] ?? "")) {
      throw new CliError("Comment must start with a letter or number", "invalid_comment");
    }
    const session = await refreshSession();
    const api = new TeamApi(session.accessToken);
    const request = await api.getRequest(requestId);
    if (!request) throw new CliError(`Request ${requestId} was not found or is not visible to you`, "request_not_found");
    validateApproval(request, session.email);

    if (options.dryRun) {
      printJson({ dry_run: true, action: "approve", comment: options.comment, request: requestSummary(request) });
      return;
    }

    const approved = await api.approve(requestId, options.comment);
    const result = { approved: approved.status === "approved", request: requestSummary(approved) };
    if (jsonRequested) printJson(result);
    else process.stdout.write(`Approved ${approved.id} for ${approved.email} (${approved.accountName} / ${approved.role}).\n`);
  });

configureCommandOutput(program);

try {
  await program.parseAsync();
} catch (error) {
  const cliError =
    error instanceof CommanderError
      ? new CliError(error.message, "invalid_cli_usage")
      : asCliError(error);
  if (jsonRequested) printJson({ error: { code: cliError.code, message: cliError.message, details: cliError.details } });
  else process.stderr.write(`Error: ${cliError.message}\n`);
  process.exitCode = 1;
}
