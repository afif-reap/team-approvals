import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import WebSocket, { type RawData } from "ws";
import type { TeamConfig } from "./config.js";
import { CliError } from "./errors.js";

const DEVTOOLS_ACTIVE_PORT_PARTS = [
  "Library",
  "Application Support",
  "Google",
  "Chrome",
  "DevToolsActivePort",
];
const ENDPOINT_FILE_LIMIT = 4 * 1024;
const ENDPOINT_POLL_ATTEMPTS = 20;
const ENDPOINT_POLL_INTERVAL_MS = 25;
const MAX_CDP_PAYLOAD = 256 * 1024;
const CHROME_PERMISSION_TIMEOUT_MS = 60_000;
const CDP_REQUEST_TIMEOUT_MS = 3_000;
const SOCKET_CLOSE_TIMEOUT_MS = 1_000;
const SOCKET_TERMINATE_TIMEOUT_MS = 250;
const REDACTED = "[redacted]";

const READ_REFRESH_TOKEN_FUNCTION = function readRefreshToken(
  expectedOrigin: unknown,
  expectedClientId: unknown,
): string {
  if (typeof expectedOrigin !== "string" || typeof expectedClientId !== "string") {
    throw new Error("Invalid arguments");
  }
  if (globalThis.location.origin !== expectedOrigin) {
    throw new Error("Origin mismatch");
  }
  const prefix = `CognitoIdentityServiceProvider.${expectedClientId}.`;
  const suffix = ".refreshToken";
  const keys = Object.keys(globalThis.localStorage).filter(
    (key) => key.startsWith(prefix) && key.endsWith(suffix) && key.length > prefix.length + suffix.length,
  );
  if (keys.length !== 1) throw new Error("Refresh token key count mismatch");
  const key = keys[0];
  if (key === undefined) throw new Error("Refresh token key missing");
  const refreshToken = globalThis.localStorage.getItem(key);
  if (typeof refreshToken !== "string" || refreshToken.length === 0) {
    throw new Error("Refresh token missing");
  }
  return refreshToken;
}.toString();

type CdpCommand =
  | { method: "Target.getTargets" }
  | { method: "Target.attachToTarget"; params: { targetId: string; flatten: true } }
  | { method: "Runtime.runIfWaitingForDebugger"; sessionId: string }
  | { method: "Page.getFrameTree"; sessionId: string }
  | {
      method: "Runtime.evaluate";
      params: { expression: "globalThis"; returnByValue: false; silent: true };
      sessionId: string;
    }
  | {
      method: "Runtime.callFunctionOn";
      params: {
        objectId: string;
        functionDeclaration: string;
        arguments: [{ value: string }, { value: string }];
        awaitPromise: false;
        generatePreview: false;
        returnByValue: true;
        silent: true;
        userGesture: false;
      };
      sessionId: string;
    }
  | { method: "Runtime.releaseObject"; params: { objectId: string }; sessionId: string }
  | { method: "Target.detachFromTarget"; params: { sessionId: string } };

type CdpMessage =
  | { kind: "event" }
  | { kind: "result"; id: number; result: unknown; sessionId: string | undefined }
  | { kind: "error"; id: number; sessionId: string | undefined };

type PendingRequest = {
  id: number;
  reject: (error: CliError) => void;
  resolve: (result: unknown) => void;
  sessionId: string | undefined;
  timeout: ReturnType<typeof setTimeout>;
};

class ChromeRefreshToken {
  #refreshToken: string | undefined;

  constructor(refreshToken: string) {
    this.#refreshToken = refreshToken;
  }

  async use<T>(consume: (refreshToken: string) => Promise<T>): Promise<T> {
    const refreshToken = this.#refreshToken;
    if (refreshToken === undefined) {
      throw new CliError("Chrome authentication token was already used", "chrome_token_consumed");
    }
    this.#refreshToken = undefined;
    return consume(refreshToken);
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}

function endpointError(): CliError {
  return new CliError(
    "Chrome remote debugging is unavailable. Open chrome://inspect/#remote-debugging, enable remote debugging, then retry. If needed, run `team-approvals auth import`.",
    "chrome_remote_debugging_unavailable",
  );
}

function connectionError(): CliError {
  return new CliError(
    "Could not connect to Chrome remote debugging. Allow the connection in Chrome and retry. If needed, run `team-approvals auth import`.",
    "chrome_connection_failed",
  );
}

function invalidResponseError(): CliError {
  return new CliError("Chrome remote debugging returned an invalid response", "invalid_chrome_response");
}

function commandError(): CliError {
  return new CliError("Chrome remote debugging command failed", "chrome_cdp_failed");
}

function commandTimeoutError(): CliError {
  return new CliError("Chrome remote debugging command timed out", "chrome_cdp_timeout");
}

function cleanupError(): CliError {
  return new CliError("Chrome remote debugging cleanup failed", "chrome_cleanup_failed");
}

function unexpectedChromeError(): CliError {
  return new CliError("Chrome authentication failed", "chrome_auth_failed");
}

function safeChromeError(error: unknown): CliError {
  return error instanceof CliError ? error : unexpectedChromeError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw invalidResponseError();
  return value;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readEndpointFile(endpointPath: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(endpointPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw endpointError();
  }

  try {
    const currentUid = process.getuid?.();
    const before = await handle.stat();
    if (
      currentUid === undefined ||
      !before.isFile() ||
      before.uid !== currentUid ||
      before.size < 1 ||
      before.size > ENDPOINT_FILE_LIMIT
    ) {
      throw endpointError();
    }

    const buffer = Buffer.alloc(ENDPOINT_FILE_LIMIT);
    let bytesRead = 0;
    while (bytesRead < before.size) {
      const read = await handle.read(buffer, bytesRead, before.size - bytesRead, bytesRead);
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== before.size || bytesRead !== before.size || after.size > ENDPOINT_FILE_LIMIT) {
      throw endpointError();
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
  } catch {
    throw endpointError();
  } finally {
    try {
      await handle.close();
    } catch {
      throw endpointError();
    }
  }
}

function parseEndpoint(contents: string): string {
  const match = /^([1-9][0-9]{0,4})\n(\/devtools\/browser\/[A-Za-z0-9][A-Za-z0-9._~-]{0,255})\n?$/.exec(contents);
  if (!match) throw endpointError();
  const portText = match[1];
  const browserPath = match[2];
  if (portText === undefined || browserPath === undefined) throw endpointError();
  const port = Number(portText);
  if (!Number.isInteger(port) || port > 65_535) throw endpointError();
  return `ws://127.0.0.1:${port}${browserPath}`;
}

async function readEndpoint(): Promise<string> {
  const endpointPath = path.join(os.homedir(), ...DEVTOOLS_ACTIVE_PORT_PARTS);
  for (let attempt = 0; attempt < ENDPOINT_POLL_ATTEMPTS; attempt += 1) {
    const contents = await readEndpointFile(endpointPath);
    if (contents !== undefined) return parseEndpoint(contents);
    if (attempt + 1 < ENDPOINT_POLL_ATTEMPTS) await sleep(ENDPOINT_POLL_INTERVAL_MS);
  }
  throw endpointError();
}

function rawDataBytes(data: unknown, isBinary: unknown): Uint8Array {
  if (isBinary !== false) throw invalidResponseError();
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) {
    const buffers: Buffer[] = [];
    for (const part of data) {
      if (!Buffer.isBuffer(part)) throw invalidResponseError();
      buffers.push(part);
    }
    return Buffer.concat(buffers);
  }
  throw invalidResponseError();
}

function parseCdpMessage(data: unknown, isBinary: unknown): CdpMessage {
  try {
    const bytes = rawDataBytes(data, isBinary);
    if (bytes.byteLength > MAX_CDP_PAYLOAD) throw invalidResponseError();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed: unknown = JSON.parse(text);
    const record = requireRecord(parsed);

    if (!("id" in record)) {
      if (typeof record.method !== "string") throw invalidResponseError();
      if (record.params !== undefined && !isRecord(record.params)) throw invalidResponseError();
      if (record.sessionId !== undefined && typeof record.sessionId !== "string") throw invalidResponseError();
      return { kind: "event" };
    }

    if (typeof record.id !== "number" || !Number.isInteger(record.id) || record.id < 1) {
      throw invalidResponseError();
    }
    const sessionId = record.sessionId;
    if (sessionId !== undefined && typeof sessionId !== "string") throw invalidResponseError();
    const hasResult = Object.hasOwn(record, "result");
    const hasError = Object.hasOwn(record, "error");
    if (hasResult === hasError) throw invalidResponseError();
    if (hasError) {
      const protocolError = requireRecord(record.error);
      if (typeof protocolError.code !== "number" || typeof protocolError.message !== "string") {
        throw invalidResponseError();
      }
      return { kind: "error", id: record.id, sessionId };
    }
    return { kind: "result", id: record.id, result: record.result, sessionId };
  } catch {
    throw invalidResponseError();
  }
}

function commandRequest(id: number, command: CdpCommand): Record<string, unknown> {
  const request: Record<string, unknown> = { id, method: command.method };
  if ("params" in command) request.params = command.params;
  if ("sessionId" in command) request.sessionId = command.sessionId;
  return request;
}

class CdpClient {
  readonly #socket: WebSocket;
  #nextId = 1;
  #pending: PendingRequest | undefined;
  #unusable: "connection" | "protocol" | undefined;

  constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.on("message", this.#onMessage);
    socket.on("error", this.#onError);
    socket.on("close", this.#onClose);
  }

  request(command: CdpCommand, timeoutMs = CDP_REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (this.#pending !== undefined) return Promise.reject(invalidResponseError());
    if (this.#unusable === "protocol") return Promise.reject(invalidResponseError());
    if (this.#unusable === "connection" || this.#socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(connectionError());
    }

    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.#pending?.id !== id) return;
        this.#pending = undefined;
        this.#unusable = "protocol";
        reject(commandTimeoutError());
      }, timeoutMs);
      this.#pending = { id, reject, resolve, sessionId: "sessionId" in command ? command.sessionId : undefined, timeout };
      this.#socket.send(JSON.stringify(commandRequest(id, command)), (error) => {
        if (error) this.#rejectPending(id, connectionError(), "connection");
      });
    });
  }

  dispose(): void {
    this.#socket.off("message", this.#onMessage);
    this.#socket.off("error", this.#onError);
    this.#socket.off("close", this.#onClose);
  }

  readonly #onMessage = (data: RawData, isBinary: boolean): void => {
    let message: CdpMessage;
    try {
      message = parseCdpMessage(data, isBinary);
    } catch {
      const pendingId = this.#pending?.id;
      if (pendingId !== undefined) this.#rejectPending(pendingId, invalidResponseError(), "protocol");
      else this.#unusable = "protocol";
      return;
    }
    if (message.kind === "event") return;
    const pending = this.#pending;
    if (pending === undefined) return;
    if (message.id !== pending.id || message.sessionId !== pending.sessionId) {
      this.#rejectPending(pending.id, invalidResponseError(), "protocol");
      return;
    }
    clearTimeout(pending.timeout);
    this.#pending = undefined;
    if (message.kind === "error") pending.reject(commandError());
    else pending.resolve(message.result);
  };

  readonly #onError = (): void => {
    const pendingId = this.#pending?.id;
    if (pendingId !== undefined) this.#rejectPending(pendingId, connectionError(), "connection");
    else this.#unusable = "connection";
  };

  readonly #onClose = (): void => {
    const pendingId = this.#pending?.id;
    if (pendingId !== undefined) this.#rejectPending(pendingId, connectionError(), "connection");
    else this.#unusable = "connection";
  };

  #rejectPending(id: number, error: CliError, unusable: "connection" | "protocol"): void {
    const pending = this.#pending;
    if (pending?.id !== id) return;
    clearTimeout(pending.timeout);
    this.#pending = undefined;
    this.#unusable = unusable;
    pending.reject(error);
  }
}

function waitForSocketOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      socket.off("open", onOpen);
      socket.off("error", onFailure);
      socket.off("close", onFailure);
    };
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onFailure = (): void => {
      cleanup();
      reject(connectionError());
    };
    socket.once("open", onOpen);
    socket.once("error", onFailure);
    socket.once("close", onFailure);
  });
}

function waitForSocketClose(socket: WebSocket, timeoutMs: number): Promise<boolean> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      socket.off("close", onClose);
      resolve(false);
    }, timeoutMs);
    const onClose = (): void => {
      clearTimeout(timeout);
      resolve(true);
    };
    socket.once("close", onClose);
  });
}

async function closeSocket(socket: WebSocket): Promise<boolean> {
  if (socket.readyState === WebSocket.CLOSED) return true;
  const gracefulClose = waitForSocketClose(socket, SOCKET_CLOSE_TIMEOUT_MS);
  try {
    if (socket.readyState === WebSocket.OPEN) socket.close(1000);
    else socket.terminate();
  } catch {
    try {
      socket.terminate();
    } catch {
      return false;
    }
  }
  if (await gracefulClose) {
    await sleep(0);
    return isSocketClosed(socket);
  }

  const terminatedClose = waitForSocketClose(socket, SOCKET_TERMINATE_TIMEOUT_MS);
  try {
    socket.terminate();
  } catch {
    return false;
  }
  const terminated = await terminatedClose;
  await sleep(0);
  return terminated && isSocketClosed(socket);
}

function isSocketClosed(socket: WebSocket): boolean {
  return socket.readyState === WebSocket.CLOSED;
}

function appOrigin(appUrl: string): string {
  try {
    const url = new URL(appUrl);
    if (url.origin === "null") throw unexpectedChromeError();
    return url.origin;
  } catch {
    throw unexpectedChromeError();
  }
}

function targetIdForOrigin(result: unknown, expectedOrigin: string): string {
  const record = requireRecord(result);
  if (!Array.isArray(record.targetInfos)) throw invalidResponseError();
  const matches: string[] = [];
  for (const candidate of record.targetInfos) {
    const target = requireRecord(candidate);
    if (typeof target.targetId !== "string" || typeof target.type !== "string" || typeof target.url !== "string") {
      throw invalidResponseError();
    }
    if (target.type !== "page") continue;
    try {
      if (new URL(target.url).origin === expectedOrigin) matches.push(target.targetId);
    } catch {
      continue;
    }
  }
  if (matches.length !== 1 || matches[0] === undefined || matches[0].length === 0) {
    throw new CliError("Open exactly one signed-in TEAM tab in Chrome and retry", "chrome_team_tab_required");
  }
  return matches[0];
}

function attachedSessionId(result: unknown): string {
  const sessionId = requireRecord(result).sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) throw invalidResponseError();
  return sessionId;
}

function frameSecurityOrigin(result: unknown): string {
  const frameTree = requireRecord(requireRecord(result).frameTree);
  const frame = requireRecord(frameTree.frame);
  if (typeof frame.securityOrigin !== "string") throw invalidResponseError();
  return frame.securityOrigin;
}

function globalObjectId(result: unknown): string {
  const response = requireRecord(result);
  if (Object.hasOwn(response, "exceptionDetails")) throw invalidResponseError();
  const remoteObject = requireRecord(response.result);
  if (remoteObject.type !== "object" || typeof remoteObject.objectId !== "string" || remoteObject.objectId.length === 0) {
    throw invalidResponseError();
  }
  return remoteObject.objectId;
}

function refreshTokenResult(result: unknown): string {
  const response = requireRecord(result);
  if (Object.hasOwn(response, "exceptionDetails")) {
    throw new CliError("Chrome could not read one TEAM refresh token for this app", "chrome_refresh_token_unavailable");
  }
  const remoteObject = requireRecord(response.result);
  const value = remoteObject.value;
  if (
    remoteObject.type !== "string" ||
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 16_384
  ) {
    throw new CliError("Chrome could not read one TEAM refresh token for this app", "chrome_refresh_token_unavailable");
  }
  return value;
}

export async function readChromeRefreshToken(
  config: Pick<TeamConfig, "appUrl" | "clientId">,
): Promise<ChromeRefreshToken> {
  const expectedOrigin = appOrigin(config.appUrl);
  const endpoint = await readEndpoint();
  let socket: WebSocket;
  try {
    socket = new WebSocket(endpoint, {
      followRedirects: false,
      handshakeTimeout: CHROME_PERMISSION_TIMEOUT_MS,
      maxPayload: MAX_CDP_PAYLOAD,
      perMessageDeflate: false,
    });
  } catch {
    throw connectionError();
  }

  const ignoreSocketError = (): void => {};
  socket.on("error", ignoreSocketError);
  let client: CdpClient | undefined;
  let sessionId: string | undefined;
  let objectId: string | undefined;
  let wrappedToken: ChromeRefreshToken | undefined;
  let failure: CliError | undefined;
  let cleanupFailed = false;

  try {
    await waitForSocketOpen(socket);
    client = new CdpClient(socket);
    const targets = await client.request({ method: "Target.getTargets" }, CHROME_PERMISSION_TIMEOUT_MS);
    const targetId = targetIdForOrigin(targets, expectedOrigin);
    const attached = await client.request({
      method: "Target.attachToTarget",
      params: { targetId, flatten: true },
    });
    sessionId = attachedSessionId(attached);
    await client.request({ method: "Runtime.runIfWaitingForDebugger", sessionId });
    const frameTree = await client.request({ method: "Page.getFrameTree", sessionId });
    if (frameSecurityOrigin(frameTree) !== expectedOrigin) {
      throw new CliError("Chrome TEAM tab origin verification failed", "chrome_origin_mismatch");
    }
    const evaluated = await client.request({
      method: "Runtime.evaluate",
      params: { expression: "globalThis", returnByValue: false, silent: true },
      sessionId,
    });
    objectId = globalObjectId(evaluated);
    wrappedToken = new ChromeRefreshToken(
      refreshTokenResult(
        await client.request({
          method: "Runtime.callFunctionOn",
          params: {
            objectId,
            functionDeclaration: READ_REFRESH_TOKEN_FUNCTION,
            arguments: [{ value: expectedOrigin }, { value: config.clientId }],
            awaitPromise: false,
            generatePreview: false,
            returnByValue: true,
            silent: true,
            userGesture: false,
          },
          sessionId,
        }),
      ),
    );
  } catch (error) {
    failure = safeChromeError(error);
  } finally {
    if (client !== undefined && objectId !== undefined && sessionId !== undefined) {
      try {
        await client.request({ method: "Runtime.releaseObject", params: { objectId }, sessionId });
      } catch {
        cleanupFailed = true;
      }
    }
    if (client !== undefined && sessionId !== undefined) {
      try {
        await client.request({ method: "Target.detachFromTarget", params: { sessionId } });
      } catch {
        cleanupFailed = true;
      }
    }
    const socketClosed = await closeSocket(socket);
    if (!socketClosed) cleanupFailed = true;
    client?.dispose();
    if (socketClosed) socket.off("error", ignoreSocketError);
  }

  if (failure !== undefined) throw failure;
  if (cleanupFailed) throw cleanupError();
  if (wrappedToken === undefined) throw unexpectedChromeError();
  return wrappedToken;
}
