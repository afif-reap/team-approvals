import net from "node:net";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import fs from "node:fs";
import { CliError } from "./errors.js";

type RpcResponse = {
  id?: number;
  result?: unknown;
  error?: { message?: string };
  method?: string;
  params?: unknown;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

export class ChromeBridge extends EventEmitter {
  private socket: net.Socket | null = null;
  private buffer = "";
  private requestId = 0;
  private readonly pending = new Map<number, PendingRequest>();

  async connect(): Promise<void> {
    if (this.socket) return;
    const socketPath = path.join(os.tmpdir(), "opzero-chrome-native-host.sock");
    try {
      const stat = fs.statSync(socketPath);
      const currentUid = process.getuid?.();
      if (!stat.isSocket() || currentUid === undefined || stat.uid !== currentUid || (stat.mode & 0o022) !== 0) {
        throw new Error("unsafe socket ownership or permissions");
      }
    } catch {
      throw new CliError("Opzero Chrome socket ownership or permissions are unsafe", "chrome_socket_unsafe");
    }

    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      socket.setEncoding("utf8");
      socket.once("connect", () => {
        this.socket = socket;
        resolve();
      });
      socket.once("error", reject);
      socket.on("data", (chunk: string) => this.handleData(chunk));
      socket.on("close", () => {
        this.socket = null;
        for (const request of this.pending.values()) {
          request.reject(new CliError("Opzero Chrome disconnected", "chrome_disconnected"));
        }
        this.pending.clear();
      });
    }).catch(() => {
      throw new CliError(
        "Opzero Chrome is unavailable. Start Chrome with the Opzero Chrome extension enabled, then retry",
        "chrome_unavailable",
      );
    });
  }

  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    await this.connect();
    const socket = this.socket;
    if (!socket) throw new CliError("Opzero Chrome is unavailable", "chrome_unavailable");

    const id = ++this.requestId;
    const response = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
    });
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return response;
  }

  close(): void {
    this.socket?.end();
    this.socket = null;
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.handleMessage(JSON.parse(line) as RpcResponse);
      newline = this.buffer.indexOf("\n");
    }
  }

  private handleMessage(message: RpcResponse): void {
    if (message.id !== undefined) {
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.error) request.reject(new CliError(message.error.message ?? "Chrome request failed", "chrome_error"));
      else request.resolve(message.result);
      return;
    }
    if (message.method) this.emit(message.method, message.params);
  }
}

type ChromeTab = { id: number };

export async function captureOAuthRedirect(authorizeUrl: string, redirectUri: string, expectedState: string): Promise<string> {
  const bridge = new ChromeBridge();
  const sessionId = `team-approvals-${crypto.randomUUID()}`;
  const turnId = crypto.randomUUID();
  let tabId: number | null = null;

  try {
    await bridge.call("ping");
    const tab = await bridge.call<ChromeTab>("createTab", { session_id: sessionId, turn_id: turnId });
    tabId = tab.id;
    await bridge.call("nameSession", { session_id: sessionId, turn_id: turnId, name: "TEAM approvals login" });
    await bridge.call("attach", { session_id: sessionId, turn_id: turnId, tabId });
    await bridge.call("executeCdp", {
      session_id: sessionId,
      turn_id: turnId,
      target: { tabId },
      method: "Page.enable",
    });
    await bridge.call("executeCdp", {
      session_id: sessionId,
      turn_id: turnId,
      target: { tabId },
      method: "Page.navigate",
      commandParams: { url: authorizeUrl },
    });

    process.stderr.write("Complete the TEAM sign-in in Chrome.\n");
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      const response = await bridge.call<{ result?: { value?: string } }>("executeCdp", {
        session_id: sessionId,
        turn_id: turnId,
        target: { tabId },
        method: "Runtime.evaluate",
        commandParams: { expression: "location.href", returnByValue: true },
      });
      const currentUrl = response.result?.value;
      if (currentUrl) {
        const url = new URL(currentUrl);
        const expected = new URL(redirectUri);
        if (url.origin !== expected.origin || url.pathname !== expected.pathname) {
          await new Promise((resolve) => setTimeout(resolve, 350));
          continue;
        }
        const error = url.searchParams.get("error");
        if (error) {
          throw new CliError(
            url.searchParams.get("error_description") ?? error,
            "oauth_authorization_failed",
          );
        }
        if (url.searchParams.get("state") !== expectedState) {
          throw new CliError("OAuth state did not match", "oauth_state_mismatch");
        }
        const code = url.searchParams.get("code");
        if (code) return code;
      }
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
    throw new CliError("TEAM sign-in timed out after 5 minutes", "oauth_timeout");
  } finally {
    if (tabId !== null) {
      await bridge
        .call("finalizeTabs", { session_id: sessionId, turn_id: turnId, keep: [] })
        .catch(() => undefined);
    }
    bridge.close();
  }
}
