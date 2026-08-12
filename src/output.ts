import type { TeamRequest } from "./api.js";

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function printRequests(requests: TeamRequest[]): void {
  if (requests.length === 0) {
    process.stdout.write("No pending TEAM approvals.\n");
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
