import { TeamApi, validateAction, type TeamRequest } from "../api.js";
import { defaultApprovalComment } from "../config.js";
import { CliError } from "../errors.js";
import type { Prompter } from "../ui.js";
import { relativeTime, sanitizeText } from "../ui.js";

export async function runReviewWizard(
  prompter: Prompter,
  api: TeamApi,
  approverEmail: string,
): Promise<void> {
  prompter.intro("team-approvals \u2014 review pending requests");

  const loadSpin = prompter.spinner();
  loadSpin.start("Loading requests assigned to you\u2026");
  let all: TeamRequest[];
  try {
    all = await api.listPending(approverEmail, 100);
  } catch (error) {
    loadSpin.stop("Failed to load requests");
    throw error;
  }
  if (all.length === 0) {
    loadSpin.stop("No pending requests");
    prompter.outro("No pending TEAM approvals.");
    return;
  }
  loadSpin.stop(`${all.length} pending request${all.length === 1 ? "" : "s"} assigned to you`);

  const queue = [...all];

  while (queue.length > 0) {
    type PickValue = TeamRequest | null;
    const pickOptions = [
      ...queue.map((r) => ({
        value: r as PickValue,
        label: sanitizeText(r.email)?.split("@")[0]?.padEnd(10) ?? "unknown",
        hint: `${sanitizeText(r.accountName)} / ${sanitizeText(r.role)} \u00b7 ${r.duration}h \u00b7 ${sanitizeText(r.ticketNo) || "no ticket"} \u00b7 ${relativeTime(r.createdAt)}`,
      })),
      { value: null as PickValue, label: "Quit", hint: "leave remaining requests untouched" },
    ];

    const picked = await prompter.select<PickValue>({
      message: `Pending requests (${queue.length} remaining)`,
      options: pickOptions,
    });

    if (!picked) {
      prompter.outro(`Done \u2014 ${queue.length} request${queue.length === 1 ? "" : "s"} left pending.`);
      return;
    }

    const r = picked;
    prompter.note(
      [
        `${sanitizeText(r.email)} \u2192 ${sanitizeText(r.accountName)} / ${sanitizeText(r.role)} \u00b7 ${r.duration}h \u00b7 ${sanitizeText(r.ticketNo) || "no ticket"}`,
        `"${sanitizeText(r.justification)}"`,
        `requested ${relativeTime(r.createdAt)}`,
      ].join("\n"),
      `Request ${r.id}`,
    );

    const action = await prompter.select<string>({
      message: "Action",
      options: [
        { value: "approve", label: "Approve" },
        { value: "reject", label: "Reject\u2026" },
        { value: "skip", label: "Skip", hint: "decide later" },
      ],
    });

    if (action === "skip") continue;

    if (action === "approve") {
      const comment = await prompter.text({
        message: "Comment",
        placeholder: defaultApprovalComment,
        defaultValue: defaultApprovalComment,
        validate: (v) => {
          if (!/[\p{L}\p{N}]/u.test(v[0] ?? "")) return "Comment must start with a letter or number";
          return undefined;
        },
      });

      const ok = await prompter.confirm({ message: `Approve ${r.id} for ${sanitizeText(r.email)}?` });
      if (!ok) continue;

      const approveSpin = prompter.spinner();
      try {
        validateAction(r, approverEmail);
        approveSpin.start("Approving\u2026");
        const approved = await api.approve(r.id, comment);
        if (approved.status !== "approved") {
          throw new CliError(`TEAM returned unexpected approval status ${approved.status ?? "missing"}`, "invalid_api_response");
        }
        approveSpin.stop(`Approved ${r.id} \u2014 ${sanitizeText(r.email)} (${sanitizeText(r.accountName)} / ${sanitizeText(r.role)})`);
      } catch (error) {
        if (error instanceof CliError && error.code === "request_not_pending") {
          approveSpin.stop(`${r.id} is no longer pending \u2014 skipped`);
        } else {
          approveSpin.stop("Approval failed");
          throw error;
        }
      }
      queue.splice(queue.indexOf(r), 1);
    }

    if (action === "reject") {
      const reason = await prompter.text({
        message: "Rejection reason",
        placeholder: "Reason is required",
        validate: (v) => {
          if (!/[\p{L}\p{N}]/u.test(v[0] ?? "")) return "Rejection reason must start with a letter or number";
          return undefined;
        },
      });

      const ok = await prompter.confirm({ message: `Reject ${r.id} for ${sanitizeText(r.email)}?` });
      if (!ok) continue;

      const rejectSpin = prompter.spinner();
      try {
        validateAction(r, approverEmail);
        rejectSpin.start("Rejecting\u2026");
        const rejected = await api.reject(r.id, reason);
        if (rejected.status !== "rejected") {
          throw new CliError(`TEAM returned unexpected rejection status ${rejected.status ?? "missing"}`, "invalid_api_response");
        }
        rejectSpin.stop(`Rejected ${r.id} \u2014 "${sanitizeText(reason)}"`);
      } catch (error) {
        if (error instanceof CliError && error.code === "request_not_pending") {
          rejectSpin.stop(`${r.id} is no longer pending \u2014 skipped`);
        } else {
          rejectSpin.stop("Rejection failed");
          throw error;
        }
      }
      queue.splice(queue.indexOf(r), 1);
    }

    if (queue.length > 0) {
      prompter.note(`${queue.length} remaining`, "Queue");
    }
  }

  prompter.outro("All pending requests handled.");
}
