import crypto from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { getConfig, type TeamConfig } from "./config.js";
import { captureOAuthRedirect } from "./browser.js";
import { CliError } from "./errors.js";
import { deleteRefreshToken, readRefreshToken, saveRefreshToken } from "./keychain.js";

export type Identity = {
  email: string;
  username: string;
};

export type AuthSession = Identity & {
  accessToken: string;
  expiresAt: string;
};

type TokenResponse = {
  access_token?: string;
  id_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

function base64Url(value: Buffer): string {
  return value.toString("base64url");
}

export function getCognitoIssuer(userPoolId: string): string {
  const region = userPoolId.split("_")[0];
  if (!region) throw new CliError("TEAM userPoolId is invalid", "invalid_config");
  return `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
}

export async function verifyIdentityToken(
  idToken: string,
  teamConfig: TeamConfig,
  verificationKey: Parameters<typeof jwtVerify>[1],
  nonce?: string,
): Promise<Identity> {
  try {
    const { payload } = await jwtVerify(idToken, verificationKey, {
      issuer: getCognitoIssuer(teamConfig.userPoolId),
      audience: teamConfig.clientId,
    });
    if (payload.token_use !== "id" || (nonce && payload.nonce !== nonce)) {
      throw new CliError("Cognito token claims are invalid", "invalid_token");
    }
    const email = payload.email;
    const username = payload["cognito:username"] ?? payload.username;
    if (typeof email !== "string" || typeof username !== "string") {
      throw new CliError("Cognito token is missing the TEAM user identity", "invalid_identity");
    }
    return { email, username };
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

async function toSession(tokens: TokenResponse, nonce?: string): Promise<AuthSession> {
  if (!tokens.access_token || !tokens.id_token) {
    throw new CliError("Cognito response did not include access and ID tokens", "invalid_token_response");
  }
  const config = getConfig();
  const issuer = getCognitoIssuer(config.userPoolId);
  const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), { timeoutDuration: 10_000 });
  return {
    ...(await verifyIdentityToken(tokens.id_token, config, jwks, nonce)),
    accessToken: tokens.access_token,
    expiresAt: new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000).toISOString(),
  };
}

export function buildAuthorizeUrl(
  codeChallenge: string,
  state: string,
  nonce: string,
  teamConfig = getConfig(),
): string {
  const url = new URL("/oauth2/authorize", teamConfig.cognitoDomain);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: teamConfig.clientId,
    redirect_uri: teamConfig.redirectUri,
    scope: teamConfig.scopes.join(" "),
    state,
    nonce,
    code_challenge_method: "S256",
    code_challenge: codeChallenge,
  }).toString();
  return url.toString();
}

export async function login(): Promise<AuthSession> {
  const config = getConfig();
  const verifier = base64Url(crypto.randomBytes(48));
  const challenge = base64Url(crypto.createHash("sha256").update(verifier).digest());
  const state = base64Url(crypto.randomBytes(24));
  const nonce = base64Url(crypto.randomBytes(24));
  const code = await captureOAuthRedirect(buildAuthorizeUrl(challenge, state, nonce), config.redirectUri, state);
  const tokens = await tokenRequest(
    new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.clientId,
      code,
      redirect_uri: config.redirectUri,
      code_verifier: verifier,
    }),
  );
  if (!tokens.refresh_token) {
    throw new CliError("Cognito did not return a refresh token", "missing_refresh_token");
  }
  const session = await toSession(tokens, nonce);
  await saveRefreshToken(tokens.refresh_token);
  const savedRefreshToken = await readRefreshToken();
  if (savedRefreshToken !== tokens.refresh_token) {
    throw new CliError("macOS Keychain did not preserve the Cognito refresh token", "keychain_token_mismatch");
  }
  return session;
}

export async function refreshSession(): Promise<AuthSession> {
  const config = getConfig();
  const refreshToken = await readRefreshToken();
  if (!refreshToken) {
    throw new CliError("Not authenticated. Run `team-approvals auth login`", "not_authenticated");
  }
  try {
    const tokens = await tokenRequest(
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: config.clientId,
        refresh_token: refreshToken,
      }),
    );
    return toSession(tokens);
  } catch (error) {
    if (error instanceof CliError && error.code === "token_invalid_grant") {
      throw new CliError(
        "The TEAM login expired or was revoked. Run `team-approvals auth login`",
        "reauthentication_required",
      );
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
