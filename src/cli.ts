#!/usr/bin/env node
import { Command, CommanderError, Option } from "commander";
import { createRequire } from "node:module";
import { TeamApi, validateApproval } from "./api.js";
import { login, refreshSession, revokeSession } from "./auth.js";
import { configPath, defaultApprovalComment, getConfig } from "./config.js";
import { asCliError, CliError } from "./errors.js";
import { readRefreshToken } from "./keychain.js";
import { printJson, printRequests, requestSummary } from "./output.js";

const program = new Command();
const jsonRequested = process.argv.includes("--json");
const packageJson = createRequire(import.meta.url)("../package.json") as { version: string };

program
  .name("team-approvals")
  .description("Approve AWS TEAM elevated-access requests from the command line")
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
        next_step: authenticated ? null : "team-approvals auth login",
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
      if (!authenticated) process.stdout.write("Next: team-approvals auth login\n");
    }
    if (!result.ok) process.exitCode = 1;
  });

const auth = program.command("auth").description("Manage TEAM Cognito authentication");

auth
  .command("login")
  .description("Sign in through TEAM Cognito and save the refresh token in macOS Keychain")
  .action(async () => {
    const session = await login();
    const result = { authenticated: true, email: session.email, expires_at: session.expiresAt };
    if (jsonRequested) printJson(result);
    else process.stdout.write(`Authenticated as ${session.email}.\n`);
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
  .description("Delete the saved TEAM refresh token")
  .action(async () => {
    const deleted = await revokeSession();
    if (jsonRequested) printJson({ authenticated: false, token_deleted: deleted });
    else process.stdout.write(deleted ? "TEAM refresh token deleted.\n" : "No TEAM refresh token was stored.\n");
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
    const result = requestSummary(request);
    if (jsonRequested) printJson(result);
    else printJson(result);
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
      const result = { dry_run: true, action: "approve", comment: options.comment, request: requestSummary(request) };
      if (jsonRequested) printJson(result);
      else printJson(result);
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
