import { spawn } from "node:child_process";
import readline from "node:readline/promises";
import { stdin, stderr } from "node:process";
import { CliError } from "./errors.js";

export function getOAuthCode(currentUrl: string, redirectUri: string, expectedState: string): string {
  let current: URL;
  try {
    current = new URL(currentUrl.trim());
  } catch {
    throw new CliError("The pasted callback is not a valid URL", "invalid_callback_url");
  }
  const expected = new URL(redirectUri);
  if (current.origin !== expected.origin || current.pathname !== expected.pathname) {
    throw new CliError("The pasted callback does not match the TEAM redirect URL", "callback_origin_mismatch");
  }

  const states = current.searchParams.getAll("state");
  const codes = current.searchParams.getAll("code");
  const errors = current.searchParams.getAll("error");
  if (states.length !== 1 || states[0] !== expectedState) {
    throw new CliError("OAuth state did not match", "oauth_state_mismatch");
  }
  if (codes.length + errors.length !== 1 || codes.length > 1 || errors.length > 1) {
    throw new CliError("The pasted callback has ambiguous OAuth parameters", "callback_parameters_invalid");
  }
  const error = errors[0];
  if (error) {
    throw new CliError(
      current.searchParams.get("error_description") ?? error,
      "oauth_authorization_failed",
    );
  }
  const code = codes[0];
  if (!code) throw new CliError("The pasted callback does not contain an authorization code", "callback_code_missing");
  return code;
}

function openBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/open", [url], {
      stdio: "ignore",
      env: { HOME: process.env.HOME, LANG: process.env.LANG },
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new CliError("Could not open the TEAM login URL", "browser_open_failed"));
    });
  });
}

export async function captureOAuthRedirect(
  authorizeUrl: string,
  redirectUri: string,
  expectedState: string,
): Promise<string> {
  if (!stdin.isTTY) {
    throw new CliError(
      "TEAM login needs an interactive terminal to paste the final callback URL",
      "interactive_terminal_required",
    );
  }
  stderr.write(`TEAM login URL:\n${authorizeUrl}\n\n`);
  await openBrowser(authorizeUrl);

  const prompt = readline.createInterface({ input: stdin, output: stderr, terminal: true });
  try {
    const callbackUrl = await prompt.question(
      "After sign-in, immediately copy the full callback URL from the address bar and paste it here:\n> ",
    );
    return getOAuthCode(callbackUrl, redirectUri, expectedState);
  } finally {
    prompt.close();
  }
}
