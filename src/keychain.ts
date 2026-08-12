import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { CliError } from "./errors.js";
import { keychainAccount, keychainService } from "./config.js";

type CommandResult = {
  stdout: string;
  stderr: string;
  code: number;
};

function runSecurity(args: string[], input?: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/security", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { HOME: process.env.HOME, LANG: process.env.LANG },
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));

    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

export async function readRefreshToken(): Promise<string | null> {
  const manifest = await readItem(keychainService);
  if (!manifest) return null;

  const match = /^v1:([a-f0-9]+):(\d+)$/.exec(manifest);
  if (!match) return null;
  const [, version, rawCount] = match;
  const count = Number(rawCount);
  if (!version || !Number.isInteger(count) || count < 1 || count > 100) {
    throw new CliError("The TEAM refresh token manifest in macOS Keychain is invalid", "keychain_manifest_invalid");
  }

  const chunks = await Promise.all(
    Array.from({ length: count }, (_, index) => readItem(chunkService(version, index))),
  );
  if (chunks.some((chunk) => chunk === null)) {
    throw new CliError("The TEAM refresh token in macOS Keychain is incomplete", "keychain_token_incomplete");
  }
  return chunks.join("");
}

async function readItem(service: string): Promise<string | null> {
  const result = await runSecurity([
    "find-generic-password",
    "-w",
    "-a",
    keychainAccount,
    "-s",
    service,
  ]);
  if (result.code === 44) return null;
  if (result.code !== 0) {
    throw new CliError("Could not read the TEAM refresh token from macOS Keychain", "keychain_read_failed");
  }
  return result.stdout.trim() || null;
}

export async function saveRefreshToken(refreshToken: string): Promise<void> {
  const previousManifest = await readItem(keychainService);
  const version = crypto.randomBytes(8).toString("hex");
  const chunks = refreshToken.match(/.{1,100}/g) ?? [];
  if (chunks.length === 0) throw new CliError("Cognito returned an empty refresh token", "invalid_refresh_token");

  try {
    await Promise.all(chunks.map((chunk, index) => writeItem(chunkService(version, index), chunk)));
    await writeItem(keychainService, `v1:${version}:${chunks.length}`);
  } catch (error) {
    await Promise.all(Array.from({ length: chunks.length }, (_, index) => deleteItem(chunkService(version, index))));
    throw error;
  }
  await deleteManifestChunks(previousManifest).catch(() => undefined);
}

async function writeItem(service: string, value: string): Promise<void> {
  const result = await runSecurity(
    [
      "add-generic-password",
      "-U",
      "-a",
      keychainAccount,
      "-s",
      service,
      "-l",
      "TEAM approvals refresh token",
      "-w",
    ],
    `${value}\n${value}\n`,
  );
  if (result.code !== 0) {
    throw new CliError("Could not save the TEAM refresh token to macOS Keychain", "keychain_write_failed");
  }
}

export async function deleteRefreshToken(): Promise<boolean> {
  const manifest = await readItem(keychainService);
  await deleteManifestChunks(manifest);
  return deleteItem(keychainService);
}

function chunkService(version: string, index: number): string {
  return `${keychainService}.refresh-token.${version}.${index}`;
}

async function deleteManifestChunks(manifest: string | null): Promise<void> {
  const match = manifest ? /^v1:([a-f0-9]+):(\d+)$/.exec(manifest) : null;
  if (!match) return;
  const [, version, rawCount] = match;
  const count = Number(rawCount);
  if (!version || !Number.isInteger(count) || count < 1 || count > 100) return;
  await Promise.all(Array.from({ length: count }, (_, index) => deleteItem(chunkService(version, index))));
}

async function deleteItem(service: string): Promise<boolean> {
  const result = await runSecurity([
    "delete-generic-password",
    "-a",
    keychainAccount,
    "-s",
    service,
  ]);
  if (result.code === 44) return false;
  if (result.code !== 0) {
    throw new CliError("Could not delete the TEAM refresh token from macOS Keychain", "keychain_delete_failed");
  }
  return true;
}
