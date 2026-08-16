import assert from "node:assert/strict";
import test from "node:test";
import { isInteractive, relativeTime, sanitizeText, truncate } from "../src/ui.js";

test("sanitizeText strips ANSI escape sequences", () => {
  assert.equal(sanitizeText("\u001B[31mred\u001B[0m"), "red");
});

test("sanitizeText collapses control characters and whitespace to single spaces", () => {
  assert.equal(sanitizeText("hello\u0007world\n\tok"), "hello world ok");
});

test("sanitizeText strips line/paragraph separators", () => {
  assert.equal(sanitizeText("a\u2028b\u2029c"), "a b c");
});

test("sanitizeText returns empty string for null/undefined", () => {
  assert.equal(sanitizeText(null), "");
  assert.equal(sanitizeText(undefined), "");
});

test("sanitizeText passes through normal text", () => {
  assert.equal(sanitizeText("Production support PAY-1042"), "Production support PAY-1042");
});

test("truncate shortens long values", () => {
  assert.equal(truncate("abcdef", 4), "abc\u2026");
});

test("truncate returns short values unchanged", () => {
  assert.equal(truncate("abc", 5), "abc");
});

test("relativeTime formats seconds", () => {
  const now = new Date("2026-01-01T12:00:30Z");
  assert.equal(relativeTime("2026-01-01T12:00:00Z", now), "30s ago");
});

test("relativeTime formats minutes", () => {
  const now = new Date("2026-01-01T12:05:00Z");
  assert.equal(relativeTime("2026-01-01T12:00:00Z", now), "5m ago");
});

test("relativeTime formats hours", () => {
  const now = new Date("2026-01-01T15:00:00Z");
  assert.equal(relativeTime("2026-01-01T12:00:00Z", now), "3h ago");
});

test("relativeTime formats days", () => {
  const now = new Date("2026-01-04T12:00:00Z");
  assert.equal(relativeTime("2026-01-01T12:00:00Z", now), "3d ago");
});

test("relativeTime handles future times", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  assert.equal(relativeTime("2026-01-02T12:00:00Z", now), "in the future");
});

test("isInteractive returns false when json requested", () => {
  assert.equal(isInteractive(true), false);
});
