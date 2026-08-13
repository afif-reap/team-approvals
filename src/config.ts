import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError } from "./errors.js";

export type TeamConfig = {
  appUrl: string;
  graphQlEndpoint: string;
  cognitoDomain: string;
  clientId: string;
  userPoolId: string;
};

export const configPath = path.join(os.homedir(), ".config", "team-approvals", "config.json");

function requireString(input: Record<string, unknown>, field: keyof TeamConfig): string {
  const value = input[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new CliError(`TEAM config field ${field} must be a non-empty string`, "invalid_config");
  }
  return value;
}

function requireHttpsUrl(input: Record<string, unknown>, field: keyof TeamConfig): string {
  const value = requireString(input, field);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError(`TEAM config field ${field} must be a valid URL`, "invalid_config");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new CliError(`TEAM config field ${field} must be an HTTPS URL without credentials`, "invalid_config");
  }
  return url.toString();
}

function parseHttpsUrl(input: Record<string, unknown>, field: keyof TeamConfig): URL {
  return new URL(requireHttpsUrl(input, field));
}

export function parseConfig(input: Record<string, unknown>): TeamConfig {
  const appUrl = parseHttpsUrl(input, "appUrl");
  const graphQlEndpoint = parseHttpsUrl(input, "graphQlEndpoint");
  const cognitoDomain = parseHttpsUrl(input, "cognitoDomain");
  const clientId = requireString(input, "clientId");
  const userPoolId = requireString(input, "userPoolId");

  if (!/^[a-z0-9]+\.appsync-api\.[a-z0-9-]+\.amazonaws\.com$/.test(graphQlEndpoint.hostname) || graphQlEndpoint.pathname !== "/graphql") {
    throw new CliError("TEAM graphQlEndpoint must be an AWS AppSync GraphQL endpoint", "invalid_config");
  }
  if (!/^[a-z0-9-]+\.auth\.[a-z0-9-]+\.amazoncognito\.com$/.test(cognitoDomain.hostname) || cognitoDomain.pathname !== "/") {
    throw new CliError("TEAM cognitoDomain must be an Amazon Cognito hosted UI domain", "invalid_config");
  }
  if (!/^[a-z0-9-]+_[A-Za-z0-9]+$/.test(userPoolId)) {
    throw new CliError("TEAM userPoolId is invalid", "invalid_config");
  }

  return {
    appUrl: appUrl.toString(),
    graphQlEndpoint: graphQlEndpoint.toString(),
    cognitoDomain: cognitoDomain.toString(),
    clientId,
    userPoolId,
  };
}

let cachedConfig: TeamConfig | null = null;

export function getConfig(): TeamConfig {
  if (cachedConfig) return cachedConfig;
  try {
    const stat = fs.statSync(configPath);
    const currentUid = process.getuid?.();
    if (currentUid === undefined || stat.uid !== currentUid || (stat.mode & 0o022) !== 0) {
      throw new CliError(`TEAM config at ${configPath} has unsafe ownership or permissions`, "unsafe_config");
    }
    const input = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    cachedConfig = parseConfig(input);
    return cachedConfig;
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new CliError(
        `TEAM config is missing. Copy config.example.json to ${configPath} and fill in the deployment values`,
        "config_missing",
      );
    }
    throw new CliError(`Could not read TEAM config at ${configPath}`, "invalid_config");
  }
}

export const keychainService = "team-approvals";
export const keychainAccount = "default";
export const defaultApprovalComment = "Approved via TEAM CLI";
