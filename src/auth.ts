import { createRemoteJWKSet, jwtVerify } from "jose";
import { getConfig, type TeamConfig } from "./config.js";
import { CliError } from "./errors.js";
import { deleteRefreshToken, readRefreshToken, saveRefreshToken } from "./keychain.js";

export type Identity = {
  email: string;
  username: string;
  userId?: string;
  groupIds?: string[];
};

export type AuthSession = Identity & {
  accessToken: string;
  idToken: string;
  expiresAt: string;
};

type TokenResponse = {
  access_token?: string;
  id_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

export function getCognitoIssuer(userPoolId: string): string {
  const region = userPoolId.split("_")[0];
  if (!region) throw new CliError("TEAM userPoolId is invalid", "invalid_config");
  return `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
}

export async function verifyIdentityToken(
  idToken: string,
  teamConfig: TeamConfig,
  verificationKey: Parameters<typeof jwtVerify>[1],
): Promise<Identity> {
  try {
    const { payload } = await jwtVerify(idToken, verificationKey, {
      issuer: getCognitoIssuer(teamConfig.userPoolId),
      audience: teamConfig.clientId,
    });
    if (payload.token_use !== "id") {
      throw new CliError("Cognito token claims are invalid", "invalid_token");
    }
    const email = payload.email;
    const username = payload["cognito:username"] ?? payload.username;
    if (typeof email !== "string" || typeof username !== "string") {
      throw new CliError("Cognito token is missing the TEAM user identity", "invalid_identity");
    }
    const userId = typeof payload.userId === "string" ? payload.userId : undefined;
    const groupIds =
      typeof payload.groupIds === "string"
        ? payload.groupIds.split(",").map((id) => id.trim()).filter(Boolean)
        : undefined;
    return {
      email,
      username,
      ...(userId ? { userId } : {}),
      ...(groupIds ? { groupIds } : {}),
    };
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("Cognito returned an invalid identity token", "invalid_token");
  }
}

async function tokenRequest(parameters: URLSearchParams): Promise<TokenResponse> {
  const config = getConfig();
  const response = await fetch(new URL("/oauth2/token", config.cognitoDomain), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: parameters,
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });
  const body = (await response.json()) as TokenResponse;
  if (!response.ok || body.error) {
    throw new CliError(
      body.error_description ?? body.error ?? `Cognito token request failed with HTTP ${response.status}`,
      body.error === "invalid_grant" ? "token_invalid_grant" : "token_request_failed",
    );
  }
  return body;
}

async function sessionFromRefreshToken(refreshToken: string): Promise<AuthSession> {
  const config = getConfig();
  const tokens = await tokenRequest(
    new URLSearchParams({
      grant_type: "refresh_token",
      client_id: config.clientId,
      refresh_token: refreshToken,
    }),
  );
  return toSession(tokens);
}

async function toSession(tokens: TokenResponse): Promise<AuthSession> {
  if (!tokens.access_token || !tokens.id_token) {
    throw new CliError("Cognito response did not include access and ID tokens", "invalid_token_response");
  }
  const config = getConfig();
  const issuer = getCognitoIssuer(config.userPoolId);
  const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), { timeoutDuration: 10_000 });
  return {
    ...(await verifyIdentityToken(tokens.id_token, config, jwks)),
    accessToken: tokens.access_token,
    idToken: tokens.id_token,
    expiresAt: new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000).toISOString(),
  };
}

export async function refreshSession(): Promise<AuthSession> {
  const refreshToken = await readRefreshToken();
  if (!refreshToken) {
    throw new CliError("Not authenticated. Run `team-approvals auth import`", "not_authenticated");
  }
  try {
    return await sessionFromRefreshToken(refreshToken);
  } catch (error) {
    if (error instanceof CliError && error.code === "token_invalid_grant") {
      throw new CliError(
        "The TEAM login expired or was revoked. Run `team-approvals auth import`",
        "reauthentication_required",
      );
    }
    throw error;
  }
}

export function parseImportedRefreshToken(input: string): string {
  const token = input.trim();
  if (!token || /\s/.test(token) || token.length < 100 || token.length > 16_384) {
    throw new CliError("Input is not a valid Cognito refresh token", "invalid_refresh_token");
  }
  return token;
}

export async function importRefreshToken(input: string): Promise<AuthSession> {
  const refreshToken = parseImportedRefreshToken(input);
  try {
    const session = await sessionFromRefreshToken(refreshToken);
    await saveRefreshToken(refreshToken);
    return session;
  } catch (error) {
    if (error instanceof CliError && error.code === "token_invalid_grant") {
      throw new CliError("Cognito rejected the imported refresh token", "invalid_refresh_token");
    }
    throw error;
  }
}

export async function revokeSession(): Promise<boolean> {
  const config = getConfig();
  const refreshToken = await readRefreshToken();
  if (!refreshToken) return false;

  try {
    const response = await fetch(new URL("/oauth2/revoke", config.cognitoDomain), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refreshToken, client_id: config.clientId }),
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
    if (!response.ok) {
      throw new CliError(`Cognito token revocation failed with HTTP ${response.status}`, "token_revocation_failed");
    }
    return true;
  } finally {
    await deleteRefreshToken();
  }
}
