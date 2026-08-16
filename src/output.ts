import type { TeamRequest } from "./api.js";
import type { RequestOption, RequestSettings } from "./requests.js";
import { printTable, relativeTime, sanitizeText } from "./ui.js";

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function printRequests(requests: TeamRequest[]): void {
  if (requests.length === 0) {
    process.stdout.write("No pending TEAM approvals.\n");
    return;
  }
  if (process.stdout.isTTY) {
    const headers = ["ID", "REQUESTER", "ACCOUNT", "ROLE", "DUR", "TICKET", "AGE"];
    const rows = requests.map((r) => [
      r.id,
      sanitizeText(r.email),
      sanitizeText(r.accountName),
      sanitizeText(r.role),
      `${r.duration}h`,
      sanitizeText(r.ticketNo) || "-",
      relativeTime(r.createdAt),
    ]);
    printTable(headers, rows);
    return;
  }
  const rows = requests.map((request) => ({
    id: request.id,
    requester: request.email ?? "",
    account: request.accountName,
    role: request.role,
    duration: `${request.duration}h`,
    justification: request.justification ?? "",
  }));
  console.table(rows);
}

export function printRequestOptions(options: RequestOption[], settings: RequestSettings): void {
  if (options.length === 0) {
    process.stdout.write("No eligible accounts in your TEAM entitlement policy.\n");
    return;
  }
  const headers = ["ACCOUNT", "ID", "ROLE", "MAX", "APPROVAL"];
  const rows: string[][] = [];
  for (const account of options) {
    for (let i = 0; i < account.roles.length; i++) {
      const role = account.roles[i]!;
      const max = Math.min(role.maxDuration, settings.maxDuration);
      const approval = role.approvalRequired && settings.approvalRequired ? "approval required" : "auto-approved";
      rows.push([
        i === 0 ? sanitizeText(account.name) : "",
        i === 0 ? account.id : "",
        sanitizeText(role.name),
        `${max}h`,
        approval,
      ]);
    }
  }
  printTable(headers, rows);
  process.stdout.write(`\nGlobal max duration: ${settings.maxDuration}h\n`);
}

export function requestSummary(request: TeamRequest): Record<string, unknown> {
  return {
    id: request.id,
    requester: request.email,
    account: request.accountName,
    account_id: request.accountId,
    role: request.role,
    start_time: request.startTime,
    duration_hours: request.duration,
    justification: request.justification,
    ticket_no: request.ticketNo,
    status: request.status,
    comment: request.comment,
    approver: request.approver,
    created_at: request.createdAt,
    updated_at: request.updatedAt,
  };
}
