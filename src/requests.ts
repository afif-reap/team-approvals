import crypto from "node:crypto";
import WebSocket from "ws";
import type { AuthSession } from "./auth.js";
import { getConfig } from "./config.js";
import { CliError } from "./errors.js";

export type EligibleAccount = { id: string; name: string };
export type EligibleRole = { id: string; name: string };
export type Entitlement = {
  accounts: EligibleAccount[];
  permissions: EligibleRole[];
  approvalRequired: boolean | null;
  duration: number | string;
};
export type RequestOption = EligibleAccount & {
  roles: Array<EligibleRole & { maxDuration: number; approvalRequired: boolean }>;
};
export type RequestSettings = { ticketRequired: boolean; maxDuration: number; approvalRequired: boolean };
export type CreateRequestInput = {
  accountId: string;
  accountName: string;
  role: string;
  roleId: string;
  startTime: string;
  duration: string;
  justification: string;
  ticketNo: string;
};
export type CreatedRequest = CreateRequestInput & {
  id: string;
  status: string | null;
  createdAt: string;
};
export type RequestDraft = { input: CreateRequestInput; approvalRequired: boolean };

type GraphQlResponse<T> = { data?: T; errors?: Array<{ message?: string }> };

const onPublishPolicy = `
  subscription OnPublishPolicy {
    onPublishPolicy {
      id
      policy {
        accounts { name id }
        permissions { name id }
        approvalRequired duration
      }
    }
  }
`;

const getUserPolicy = `
  query GetUserPolicy($userId: String, $groupIds: [String]) {
    getUserPolicy(userId: $userId, groupIds: $groupIds) { id }
  }
`;

const getSettings = `
  query GetSettings($id: ID!) {
    getSettings(id: $id) { duration ticketNo approval }
  }
`;

const getMgmtPermissions = `query GetMgmtPermissions { getMgmtPermissions { permissions } }`;
const getApprovers = `query GetApprovers($id: ID!) { getApprovers(id: $id) { groupIds } }`;
const getOu = `query GetOU($id: String) { getOU(id: $id) { Id } }`;
const listGroups = `query ListGroups($groupIds: [String]) { listGroups(groupIds: $groupIds) { members } }`;

const createRequest = `
  mutation CreateRequests($input: CreateRequestsInput!) {
    createRequests(input: $input) {
      id accountId accountName role roleId startTime duration justification ticketNo status createdAt
    }
  }
`;

export function buildRequestOptions(entitlements: Entitlement[]): RequestOption[] {
  const accounts = new Map<string, RequestOption>();
  for (const entitlement of entitlements) {
    const duration = Number(entitlement.duration);
    if (!Number.isInteger(duration) || duration < 1) {
      throw new CliError("TEAM returned an invalid entitlement duration", "invalid_policy");
    }
    for (const account of entitlement.accounts) {
      const option = accounts.get(account.id) ?? { ...account, roles: [] };
      for (const permission of entitlement.permissions) {
        const existing = option.roles.find((role) => role.id === permission.id);
        const approvalRequired = Boolean(entitlement.approvalRequired);
        if (existing) {
          existing.maxDuration = Math.max(existing.maxDuration, duration);
          existing.approvalRequired = existing.approvalRequired && approvalRequired;
        } else {
          option.roles.push({ ...permission, maxDuration: duration, approvalRequired });
        }
      }
      accounts.set(account.id, option);
    }
  }
  return [...accounts.values()]
    .map((account) => ({ ...account, roles: account.roles.sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function excludeManagementRoles(options: RequestOption[], blockedRoleIds: string[]): RequestOption[] {
  const blockedRoles = new Set(blockedRoleIds);
  return options
    .map((account) => ({ ...account, roles: account.roles.filter((role) => !blockedRoles.has(role.id)) }))
    .filter((account) => account.roles.length > 0);
}

function resolveUnique<T extends { id: string; name: string }>(values: T[], query: string, kind: string): T {
  const normalized = query.toLowerCase();
  const exactId = values.find((value) => value.id === query);
  if (exactId) return exactId;
  const matches = values.filter((value) => value.name.toLowerCase() === normalized);
  if (matches.length === 1 && matches[0]) return matches[0];
  if (matches.length > 1) throw new CliError(`${kind} name ${query} is ambiguous; use its ID`, `ambiguous_${kind}`);
  throw new CliError(`${kind} ${query} is not eligible`, `${kind}_not_eligible`);
}

export function buildRequestDraft(
  options: RequestOption[],
  settings: RequestSettings,
  args: { account: string; role: string; duration: number; justification: string; ticket?: string; startTime?: string },
): RequestDraft {
  const account = resolveUnique(options, args.account, "account");
  const role = resolveUnique(account.roles, args.role, "role");
  const maximum = Math.min(role.maxDuration, settings.maxDuration);
  if (!Number.isInteger(args.duration) || args.duration < 1 || args.duration > maximum) {
    throw new CliError(`Duration must be an integer from 1 to ${maximum}`, "invalid_duration");
  }
  if (!/[\p{L}\p{N}]/u.test(args.justification[0] ?? "")) {
    throw new CliError("Justification must start with a letter or number", "invalid_justification");
  }
  const ticket = args.ticket ?? "";
  if ((settings.ticketRequired && !ticket) || (ticket && !/^[A-Za-z0-9]/.test(ticket))) {
    throw new CliError("A valid ticket number is required", "invalid_ticket");
  }
  const startTime = args.startTime ?? new Date().toISOString();
  const rfc3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;
  if (!rfc3339.test(startTime) || !Number.isFinite(Date.parse(startTime))) {
    throw new CliError("Start time must be a valid RFC 3339 date-time with timezone", "invalid_start_time");
  }
  const normalizedStart = new Date(startTime).toISOString();
  if (startTime.endsWith("Z")) {
    const canonicalInput = startTime.replace(/\.0{1,3}Z$/, "Z");
    const canonicalNormalized = normalizedStart.replace(".000Z", "Z");
    if (canonicalInput !== canonicalNormalized) {
      throw new CliError("Start time contains an invalid calendar date", "invalid_start_time");
    }
  }
  return {
    approvalRequired: settings.approvalRequired && role.approvalRequired,
    input: {
      accountId: account.id,
      accountName: account.name,
      role: role.name,
      roleId: role.id,
      startTime: normalizedStart,
      duration: String(args.duration),
      justification: args.justification,
      ticketNo: ticket,
    },
  };
}

export class RequestsApi {
  constructor(
    private readonly session: AuthSession,
    private readonly graphQlEndpoint = getConfig().graphQlEndpoint,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await this.fetcher(this.graphQlEndpoint, {
      method: "POST",
      headers: { authorization: this.session.accessToken, "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
    const body = (await response.json()) as GraphQlResponse<T>;
    if (!response.ok || body.errors?.length || !body.data) {
      throw new CliError(body.errors?.[0]?.message ?? `TEAM API failed with HTTP ${response.status}`, "team_api_error");
    }
    return body.data;
  }

  async getSettings(): Promise<RequestSettings> {
    const data = await this.request<{
      getSettings: { duration?: string | null; ticketNo?: boolean | null; approval?: boolean | null } | null;
    }>(getSettings, { id: "settings" });
    const maxDuration = Number(data.getSettings?.duration ?? 9);
    if (!Number.isInteger(maxDuration) || maxDuration < 1) {
      throw new CliError("TEAM returned an invalid global duration", "invalid_settings");
    }
    return {
      ticketRequired: data.getSettings?.ticketNo ?? true,
      maxDuration,
      approvalRequired: data.getSettings?.approval ?? true,
    };
  }

  async getOptions(): Promise<RequestOption[]> {
    if (!this.session.userId || !this.session.groupIds) {
      throw new CliError("TEAM identity token is missing entitlement claims; sign in again", "missing_entitlement_claims");
    }
    const [policy, management] = await Promise.all([
      this.receivePolicy(),
      this.request<{ getMgmtPermissions: { permissions?: string[] | null } | null }>(getMgmtPermissions, {}),
    ]);
    return excludeManagementRoles(buildRequestOptions(policy), management.getMgmtPermissions?.permissions ?? []);
  }

  async assertApproverAvailable(accountId: string): Promise<void> {
    if (await this.hasApproverFor(accountId)) return;
    const ou = await this.request<{ getOU: { Id?: string | null } | null }>(getOu, { id: accountId });
    if (ou.getOU?.Id && (await this.hasApproverFor(ou.getOU.Id))) return;
    throw new CliError("No independent approver is available for this account", "approver_unavailable");
  }

  async create(input: CreateRequestInput): Promise<CreatedRequest> {
    const data = await this.request<{ createRequests: CreatedRequest }>(createRequest, { input });
    return data.createRequests;
  }

  private async hasApproverFor(id: string): Promise<boolean> {
    const approver = await this.request<{ getApprovers: { groupIds?: string[] | null } | null }>(getApprovers, { id });
    const groupIds = approver.getApprovers?.groupIds ?? [];
    if (groupIds.length === 0) return false;
    const groups = await this.request<{ listGroups: { members?: string[] | null } | null }>(listGroups, { groupIds });
    const required = groupIds.some((groupId) => this.session.groupIds?.includes(groupId)) ? 2 : 1;
    return (groups.listGroups?.members?.length ?? 0) >= required;
  }

  private async receivePolicy(): Promise<Entitlement[]> {
    const endpoint = new URL(this.graphQlEndpoint);
    const realtime = new URL(this.graphQlEndpoint.replace("appsync-api", "appsync-realtime-api").replace("https:", "wss:"));
    const authorization = { host: endpoint.host, Authorization: this.session.idToken };
    const socket = new WebSocket(realtime, [
      "graphql-ws",
      `header-${Buffer.from(JSON.stringify(authorization)).toString("base64url")}`,
    ]);
    const subscriptionId = crypto.randomUUID();
    const policyIds = new Set<string>();

    return new Promise<Entitlement[]>((resolve, reject) => {
      let settled = false;
      const publishedPolicies = new Map<string, Entitlement[]>();
      let policyAttempts = 0;
      let policyRetry: NodeJS.Timeout | null = null;
      const finish = (result: Entitlement[] | Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (policyRetry) clearInterval(policyRetry);
        socket.terminate();
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      const timeout = setTimeout(
        () => finish(new CliError("TEAM entitlement policy timed out", "policy_timeout")),
        30_000,
      );
      socket.on("open", () => socket.send(JSON.stringify({ type: "connection_init" })));
      socket.on("error", () => finish(new CliError("TEAM realtime connection failed", "policy_connection_failed")));
      socket.on("message", async (event) => {
        const message = JSON.parse(String(event)) as {
          id?: string;
          type?: string;
          payload?: { data?: { onPublishPolicy?: { id?: string; policy?: Entitlement[] } }; errors?: Array<{ message?: string }> };
        };
        if (message.type === "connection_ack") {
          socket.send(
            JSON.stringify({
              id: subscriptionId,
              type: "start",
              payload: {
                data: JSON.stringify({ query: onPublishPolicy, variables: {} }),
                extensions: { authorization },
              },
            }),
          );
        } else if (message.type === "start_ack" && message.id === subscriptionId) {
          const requestPolicy = async () => {
            if (settled || policyAttempts >= 5) {
              if (policyRetry) clearInterval(policyRetry);
              return;
            }
            policyAttempts += 1;
            try {
              const data = await this.request<{ getUserPolicy: { id: string } }>(getUserPolicy, {
                userId: this.session.userId,
                groupIds: this.session.groupIds,
              });
              policyIds.add(data.getUserPolicy.id);
              const alreadyPublished = publishedPolicies.get(data.getUserPolicy.id);
              if (alreadyPublished) finish(alreadyPublished);
            } catch (error) {
              finish(error instanceof Error ? error : new Error(String(error)));
            }
          };
          policyRetry = setInterval(() => void requestPolicy(), 1_500);
          void requestPolicy();
        } else if (message.type === "data" && message.id === subscriptionId) {
          const published = message.payload?.data?.onPublishPolicy;
          if (published?.id) {
            const policy = published.policy ?? [];
            if (policyIds.has(published.id)) finish(policy);
            else publishedPolicies.set(published.id, policy);
          }
        } else if (message.type === "error" || message.payload?.errors?.length) {
          finish(new CliError(message.payload?.errors?.[0]?.message ?? "TEAM policy subscription failed", "policy_error"));
        }
      });
    });
  }
}
