import { CliError } from "../errors.js";
import { buildRequestDraft, type RequestOption, type RequestSettings, RequestsApi } from "../requests.js";
import type { Prompter, SelectOption } from "../ui.js";
import { sanitizeText } from "../ui.js";

export function toRfc3339NoMillis(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

function fmtLocal(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function generateTimeSlots(now: Date, dayOffset: 0 | 1): Array<{ label: string; date: Date }> {
  const base = new Date(now);
  base.setDate(base.getDate() + dayOffset);
  const slots: Array<{ label: string; date: Date }> = [];
  for (let h = 0; h < 24; h++) {
    for (const m of [0, 30] as const) {
      const d = new Date(base);
      d.setHours(h, m, 0, 0);
      if (d <= now) continue;
      slots.push({ label: `${pad2(h)}:${pad2(m)}`, date: d });
    }
  }
  return slots;
}

export type CreateAnswers = {
  account: string;
  role: string;
  duration: number;
  justification: string;
  ticket: string;
  startTime?: string;
};

export function missingCreateFields(flags: Partial<CreateAnswers>): string[] {
  const missing: string[] = [];
  if (flags.account === undefined) missing.push("--account");
  if (flags.role === undefined) missing.push("--role");
  if (flags.duration === undefined || flags.duration === null) missing.push("--duration");
  if (flags.justification === undefined) missing.push("--justification");
  return missing;
}

function resolveUnique<T extends { id: string; name: string }>(values: T[], query: string, kind: string): T {
  const normalized = query.toLowerCase();
  const exactId = values.find((v) => v.id === query);
  if (exactId) return exactId;
  const matches = values.filter((v) => v.name.toLowerCase() === normalized);
  if (matches.length === 1 && matches[0]) return matches[0];
  if (matches.length > 1) throw new CliError(`${kind} name ${query} is ambiguous; use its ID`, `ambiguous_${kind}`);
  throw new CliError(`${kind} ${query} is not eligible`, `${kind}_not_eligible`);
}

export async function runCreateWizard(
  prompter: Prompter,
  api: RequestsApi,
  flags: Partial<CreateAnswers>,
  forcedDryRun: boolean,
): Promise<void> {
  prompter.intro("team-approvals \u2014 new access request");

  let options: RequestOption[];
  let settings: RequestSettings;
  const loadSpin = prompter.spinner();
  loadSpin.start("Loading your entitlements\u2026");
  try {
    [options, settings] = await Promise.all([api.getOptions(), api.getSettings()]);
  } catch (error) {
    loadSpin.stop("Failed to load entitlements");
    throw error;
  }
  if (options.length === 0) {
    loadSpin.stop("No eligible accounts");
    throw new CliError("No eligible accounts in your TEAM entitlement policy", "no_entitlements");
  }
  loadSpin.stop(`Entitlements loaded \u2014 ${options.length} account${options.length === 1 ? "" : "s"} \u00b7 global max ${settings.maxDuration}h`);

  let resolvedAccount: RequestOption;
  if (flags.account !== undefined) {
    resolvedAccount = resolveUnique(options, flags.account, "account");
  } else {
    resolvedAccount = await prompter.filterSelect<RequestOption>({
      message: "Account",
      placeholder: "Type to filter\u2026",
      options: options.map((a) => ({ value: a, label: sanitizeText(a.name), hint: a.id })),
    });
  }

  const accountRoles = resolvedAccount.roles;
  let resolvedRole: (typeof accountRoles)[number];
  if (flags.role !== undefined) {
    resolvedRole = resolveUnique(accountRoles, flags.role, "role");
  } else {
    resolvedRole = await prompter.select({
      message: "Role",
      options: accountRoles.map((r) => {
        const max = Math.min(r.maxDuration, settings.maxDuration);
        const approval = r.approvalRequired && settings.approvalRequired ? "approval required" : "auto-approved";
        return { value: r, label: sanitizeText(r.name), hint: `max ${max}h \u00b7 ${approval}` };
      }),
    });
  }

  const maxDuration = Math.min(resolvedRole.maxDuration, settings.maxDuration);

  let duration: number;
  if (flags.duration !== undefined && flags.duration !== null) {
    duration = flags.duration;
  } else {
    const durationStr = await prompter.text({
      message: "Duration (hours)",
      placeholder: "1",
      defaultValue: "1",
      validate: (v) => {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > maxDuration) {
          return `Duration must be an integer from 1 to ${maxDuration}`;
        }
        return undefined;
      },
    });
    duration = Number(durationStr);
  }

  let ticket: string;
  if (flags.ticket !== undefined) {
    ticket = flags.ticket;
  } else {
    ticket = await prompter.text({
      message: "Ticket",
      placeholder: "N/A",
      defaultValue: "N/A",
      validate: (v) => {
        if (!/^[A-Za-z0-9]/.test(v)) return "A valid ticket number is required";
        return undefined;
      },
    });
  }

  let justification: string;
  if (flags.justification !== undefined) {
    justification = flags.justification;
  } else {
    justification = await prompter.text({
      message: "Justification",
      placeholder: "Why do you need this access?",
      validate: (v) => {
        if (!/^[\p{L}\p{N}]/u.test(v)) return "Justification must start with a letter or number";
        return undefined;
      },
    });
  }

  const now = new Date();
  let startTime: string | undefined;
  let startLabel = `now (${fmtLocal(now)})`;

  if (flags.startTime !== undefined) {
    startTime = flags.startTime;
    startLabel = flags.startTime;
  } else {
    const todaySlots = generateTimeSlots(now, 0);
    const startOptions: SelectOption<string>[] = [
      { value: "now", label: "Now", hint: fmtLocal(now) },
    ];
    if (todaySlots.length > 0) {
      startOptions.push({ value: "today", label: "Today at\u2026", hint: "pick a time" });
    }
    startOptions.push(
      { value: "tomorrow", label: "Tomorrow at\u2026", hint: "pick a time" },
      { value: "custom", label: "Custom\u2026", hint: "RFC 3339" },
    );

    const startChoice = await prompter.select<string>({
      message: "Start time",
      options: startOptions,
    });

    if (startChoice === "today" || startChoice === "tomorrow") {
      const dayOffset: 0 | 1 = startChoice === "today" ? 0 : 1;
      const slots = startChoice === "today" ? todaySlots : generateTimeSlots(now, 1);
      const slotOptions: SelectOption<Date>[] = slots.map((s) => ({
        value: s.date,
        label: s.label,
        hint: fmtLocal(s.date),
      }));
      const picked = await prompter.filterSelect<Date>({
        message: `Time \u2014 ${startChoice}`,
        placeholder: "Type to filter, e.g. 14",
        options: slotOptions,
      });
      startTime = toRfc3339NoMillis(picked);
      startLabel = fmtLocal(picked);
    } else if (startChoice === "custom") {
      const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/;
      const raw = await prompter.text({
        message: "Start time",
        placeholder: toRfc3339NoMillis(now),
        defaultValue: toRfc3339NoMillis(now),
        validate: (v) => {
          if (!rfc3339.test(v) || !Number.isFinite(Date.parse(v))) {
            return "Start time must be a valid RFC 3339 date-time with timezone";
          }
          return undefined;
        },
      });
      startTime = raw;
      startLabel = fmtLocal(new Date(raw));
    }
  }

  const draft = buildRequestDraft(options, settings, {
    account: resolvedAccount.id,
    role: resolvedRole.id,
    duration,
    justification,
    ticket,
    startTime,
  });

  if (draft.approvalRequired) {
    const approverSpin = prompter.spinner();
    approverSpin.start("Checking approver availability\u2026");
    try {
      await api.assertApproverAvailable(draft.input.accountId);
      approverSpin.stop("Approver available");
    } catch (error) {
      approverSpin.stop("Approver check failed");
      throw error;
    }
  }

  const approvalLine = draft.approvalRequired
    ? "Approval required: yes"
    : "Approval required: no \u2014 session activates at start time";

  prompter.note(
    [
      `${sanitizeText(resolvedAccount.name)} (${resolvedAccount.id}) \u00b7 ${sanitizeText(resolvedRole.name)} \u00b7 ${duration}h \u00b7 starts ${startLabel}`,
      `Ticket ${sanitizeText(ticket)} \u2014 "${sanitizeText(justification)}"`,
      approvalLine,
    ].join("\n"),
    "Review",
  );

  const dryRunNote = [
    `accountId:        "${draft.input.accountId}"`,
    `accountName:      "${sanitizeText(draft.input.accountName)}"`,
    `role:             "${sanitizeText(draft.input.role)}"`,
    `roleId:           "${draft.input.roleId}"`,
    `startTime:        "${draft.input.startTime}"`,
    `duration:         "${draft.input.duration}"`,
    `ticketNo:         "${sanitizeText(draft.input.ticketNo)}"`,
    `justification:    "${sanitizeText(draft.input.justification)}"`,
    `approval_required: ${draft.approvalRequired}`,
  ].join("\n");

  if (forcedDryRun) {
    prompter.note(dryRunNote, "Dry-run payload");
    prompter.outro("Dry-run only \u2014 nothing was created.");
    return;
  }

  const action = await prompter.select<string>({
    message: "How do you want to proceed?",
    options: [
      { value: "dry", label: "Dry-run first", hint: "validate and show the payload without creating" },
      { value: "submit", label: "Submit now" },
      { value: "cancel", label: "Cancel" },
    ],
  });

  if (action === "cancel") {
    prompter.outro("Cancelled \u2014 nothing was sent.");
    return;
  }

  if (action === "dry") {
    prompter.note(dryRunNote, "Dry-run payload");
    const submitNow = await prompter.confirm({ message: "Submit this request now?" });
    if (!submitNow) {
      prompter.outro("Dry-run only \u2014 nothing was created.");
      return;
    }
  }

  const submitSpin = prompter.spinner();
  submitSpin.start("Submitting createRequests mutation\u2026");
  try {
    const created = await api.create(draft.input);
    submitSpin.stop("Request created");
    const outcome = draft.approvalRequired
      ? `Created request ${created.id} \u2014 pending approval.`
      : `Created request ${created.id} \u2014 auto-approved. Session activates for ${duration}h.`;
    prompter.outro(outcome);
  } catch (error) {
    submitSpin.stop("Request failed");
    throw error;
  }
}
