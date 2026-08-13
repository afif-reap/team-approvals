import { spawn } from "node:child_process";
import { Entry } from "@napi-rs/keyring";
import { CliError } from "./errors.js";
import { keychainAccount, keychainService } from "./config.js";

const refreshTokenService = `${keychainService}.refresh-token`;

function refreshTokenEntry(): Entry {
  return new Entry(refreshTokenService, keychainAccount);
}

export async function readRefreshToken(): Promise<string | null> {
  try {
    const current = refreshTokenEntry().getPassword();
    if (current) return current;
  } catch {
    throw new CliError("Could not read the TEAM refresh token from macOS Keychain", "keychain_read_failed");
  }

  const legacy = await readLegacyRefreshToken();
  if (legacy) {
    await saveRefreshToken(legacy);
    await deleteLegacyRefreshToken().catch(() => undefined);
  }
  return legacy;
}

export async function saveRefreshToken(refreshToken: string): Promise<void> {
  if (!refreshToken) throw new CliError("Cognito returned an empty refresh token", "invalid_refresh_token");
  try {
    refreshTokenEntry().setPassword(refreshToken);
  } catch {
    throw new CliError("Could not save the TEAM refresh token to macOS Keychain", "keychain_write_failed");
  }
}

export async function deleteRefreshToken(): Promise<boolean> {
  let deleted: boolean;
  try {
    deleted = refreshTokenEntry().deletePassword();
  } catch {
    throw new CliError("Could not delete the TEAM refresh token from macOS Keychain", "keychain_delete_failed");
  }
  return (await deleteLegacyRefreshToken()) || deleted;
}

type CommandResult = { stdout: string; code: number };

function security(args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/security", args, {
      stdio: ["ignore", "pipe", "ignore"],
      env: { HOME: process.env.HOME, LANG: process.env.LANG },
    });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, code: code ?? 1 }));
  });
}

async function readLegacyItem(service: string): Promise<string | null> {
  const result = await security(["find-generic-password", "-w", "-a", keychainAccount, "-s", service]);
  if (result.code === 44) return null;
  if (result.code !== 0) throw new CliError("Could not read legacy TEAM authentication", "keychain_read_failed");
  return result.stdout.trim() || null;
}

async function deleteLegacyItem(service: string): Promise<boolean> {
  const result = await security(["delete-generic-password", "-a", keychainAccount, "-s", service]);
  if (result.code === 44) return false;
  if (result.code !== 0) throw new CliError("Could not delete legacy TEAM authentication", "keychain_delete_failed");
  return true;
}

async function readLegacyRefreshToken(): Promise<string | null> {
  const manifest = await readLegacyItem(keychainService);
  const match = manifest ? /^v1:([a-f0-9]+):(\d+)$/.exec(manifest) : null;
  if (!match) return null;
  const [, version, rawCount] = match;
  const count = Number(rawCount);
  if (!version || !Number.isInteger(count) || count < 1 || count > 100) {
    throw new CliError("The legacy TEAM refresh-token manifest is invalid", "keychain_manifest_invalid");
  }
  const chunks = await Promise.all(
    Array.from({ length: count }, (_, index) => readLegacyItem(`${keychainService}.refresh-token.${version}.${index}`)),
  );
  if (chunks.some((chunk) => chunk === null)) {
    throw new CliError("The legacy TEAM refresh token is incomplete", "keychain_token_incomplete");
  }
  return chunks.join("");
}

async function deleteLegacyRefreshToken(): Promise<boolean> {
  const manifest = await readLegacyItem(keychainService);
  const match = manifest ? /^v1:([a-f0-9]+):(\d+)$/.exec(manifest) : null;
  let deleted = false;
  if (match?.[1]) {
    const count = Number(match[2]);
    for (let index = 0; Number.isInteger(count) && index < count && index < 100; index += 1) {
      deleted = (await deleteLegacyItem(`${keychainService}.refresh-token.${match[1]}.${index}`)) || deleted;
    }
  }
  return (await deleteLegacyItem(keychainService)) || deleted;
}
