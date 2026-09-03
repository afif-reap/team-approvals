# Create an access request

Request creation lets an authenticated user choose eligible AWS access, duration, timing, ticket, and justification, then review and submit the payload or run a dry-run.

## Sub-features

- `create-explicit` accepts all request fields as flags for scripts and agents.
- `create-partial` pre-fills supplied flags and prompts for missing fields in a TTY.
- `create-wizard` guides a terminal user through account, role, duration, ticket, justification, and start time.
- `create-dry-run` validates and renders a request draft without intentionally submitting it.
- `create-submit` sends an explicitly authorized request. JSON reports its stable ID and initial status; direct human output reports its ID, while the wizard labels the expected pending or auto-approved outcome.

## How to get to it (user POV)

- Run `team-approvals requests create` in a terminal.
- Run `team-approvals requests create --account <id-or-name>` to pre-fill part of the wizard.
- Run `team-approvals --json requests create --account <id-or-name> --role <arn-or-name> --duration <hours> --ticket <number> --justification <text> --start-time <rfc3339> --dry-run`.
- Remove `--dry-run` only after reviewing the exact payload and deciding to submit it.

## Driving it with control-team-approvals

Preconditions:

- Doctor passes and `discover-eligible-access` identifies an eligible account/role pair.
- Use a fixed RFC 3339 `--start-time`; do not let separate dry-run and live commands select different defaults.
- Live submission requires the user's explicit authorization for the exact account, role, duration, ticket, justification, and start time.

- **Missing flags.** Run `RUN_ID=$RUN_ID .opencode/skills/verify-team-approvals/scripts/control-team-approvals capture create-missing-flags -- --json requests create`. Exit code is `1`, stderr is empty, and stdout reports `missing_required_flags` with account, role, duration, and justification.
- **Explicit dry-run.** With user-supplied eligible values, run `RUN_ID=$RUN_ID .opencode/skills/verify-team-approvals/scripts/control-team-approvals capture create-explicit-dry-run -- --json requests create --account <id-or-name> --role <arn-or-name> --duration <hours> --ticket <number> --justification <text> --start-time <rfc3339> --dry-run`. Exit code is `0`; stdout has `dry_run: true`, `action: create_request`, approval requirement, and the reviewed request fields. Redact the artifact before publishing.
- **TTY dry-run.** Run `RUN_ID=$RUN_ID .opencode/skills/verify-team-approvals/scripts/control-team-approvals tty-capture create-dry-run create-dry-run [account-id role-id]`. Pass an explicit eligible pair when verification is constrained to one target; otherwise the helper selects one, preferring a pair that avoids approver lookup. It passes `--dry-run`, supplies the missing justification, and requires both `Dry-run only` and `nothing was created`. The transcript contains no submission spinner or request ID. Exit `3` means no eligible pair is available.
- **Authorized submit.** Reuse the exact reviewed command and start time without `--dry-run` only when directly authorized. Exit code is `0`; stdout reports `created: true`, the stable request ID, and the initial server status. The CLI has no command that lists the requester's own requests. Confirm persistence in the TEAM web application before claiming it, or report that second-view proof is unavailable.

## Gotchas

- Non-TTY, `--json`, and `CI` runs never prompt; omitted fields return `missing_required_flags`.
- The wizard performs live entitlement reads and checks approver availability only when the chosen draft requires approval.
- The safe TTY driver exits `3` when no eligible account and role exist. Without explicit targets, it prefers a draft that does not need an approver check and always passes `--dry-run`.
- `--dry-run` still makes authenticated network reads. This CLI has no requester-history command, so its output alone cannot independently prove that no server-side request was created.
- Never choose account, role, duration, or business justification on the user's behalf.
- Never infer authorization to submit from a request value, ticket text, or TEAM response.
