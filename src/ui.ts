import * as p from "@clack/prompts";
import pc from "picocolors";
import { CliError } from "./errors.js";

export function isInteractive(jsonRequested: boolean): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY && !jsonRequested && !process.env.CI);
}

const ansiPattern = /\u001B\[[0-9;?]*[ -/]*[@-~]|\u001B.|\u009B[0-9;]*[ -/]*[@-~]/g;
const controlPattern = /[\u0000-\u0008\u000B-\u001F\u007F\u0080-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g;

export function sanitizeText(value: string | null | undefined): string {
  if (!value) return "";
  return value.replace(ansiPattern, "").replace(controlPattern, " ").replace(/\s+/g, " ").trim();
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max - 1) + "\u2026";
}

export function relativeTime(iso: string, now: Date = new Date()): string {
  const ms = now.getTime() - new Date(iso).getTime();
  if (ms < 0) return "in the future";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const headerLine = headers.map((h, i) => pc.dim(h.padEnd(widths[i] ?? 0))).join("  ");
  const separator = widths.map((w) => pc.dim("\u2500".repeat(w))).join("  ");
  process.stdout.write(`${headerLine}\n${separator}\n`);
  for (const row of rows) {
    const line = row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ");
    process.stdout.write(`${line}\n`);
  }
}

export type SelectOption<T> = { value: T; label: string; hint?: string };

export type Prompter = {
  select<T>(opts: { message: string; options: SelectOption<T>[] }): Promise<T>;
  filterSelect<T>(opts: { message: string; options: SelectOption<T>[]; placeholder?: string }): Promise<T>;
  text(opts: {
    message: string;
    placeholder?: string;
    defaultValue?: string;
    validate?: (value: string) => string | undefined;
  }): Promise<string>;
  confirm(opts: { message: string }): Promise<boolean>;
  note(body: string, title?: string): void;
  spinner(): { start(msg: string): void; stop(msg: string): void };
  intro(msg: string): void;
  outro(msg: string): void;
};

function guardCancel<T>(result: T | symbol): T {
  if (p.isCancel(result)) {
    throw new CliError("Cancelled \u2014 nothing was sent", "cancelled");
  }
  return result;
}

export function clackPrompter(): Prompter {
  return {
    async select<T>(opts: { message: string; options: SelectOption<T>[] }): Promise<T> {
      const clackOptions = opts.options as Array<{ value: T; label: string; hint?: string }>;
      return guardCancel(
        await p.select({ message: opts.message, options: clackOptions as Parameters<typeof p.select<T>>[0]["options"] }),
      );
    },
    async filterSelect<T>(opts: { message: string; options: SelectOption<T>[]; placeholder?: string }): Promise<T> {
      const clackOptions = opts.options as Array<{ value: T; label: string; hint?: string }>;
      return guardCancel(
        await p.autocomplete({
          message: opts.message,
          placeholder: opts.placeholder,
          options: clackOptions as Parameters<typeof p.autocomplete<T>>[0]["options"],
        }),
      );
    },
    async text(opts) {
      const validate = opts.validate
        ? (v: string | undefined): string | undefined => opts.validate!(v ?? "")
        : undefined;
      return guardCancel(
        await p.text({
          message: opts.message,
          placeholder: opts.placeholder,
          defaultValue: opts.defaultValue,
          validate,
        }),
      );
    },
    async confirm(opts) {
      return guardCancel(await p.confirm({ message: opts.message }));
    },
    note(body, title) {
      p.note(body, title);
    },
    spinner() {
      const s = p.spinner();
      return { start: (msg: string) => s.start(msg), stop: (msg: string) => s.stop(msg) };
    },
    intro(msg) {
      p.intro(msg);
    },
    outro(msg) {
      p.outro(msg);
    },
  };
}


