import assert from "node:assert/strict";
import test from "node:test";
import { generateTimeSlots, missingCreateFields, toRfc3339NoMillis } from "../src/wizards/create.js";

test("toRfc3339NoMillis removes milliseconds", () => {
  const d = new Date("2026-08-13T10:00:00.000Z");
  assert.equal(toRfc3339NoMillis(d), "2026-08-13T10:00:00Z");
});

test("toRfc3339NoMillis works with non-zero milliseconds", () => {
  const d = new Date("2026-08-13T10:00:00.123Z");
  assert.equal(toRfc3339NoMillis(d), "2026-08-13T10:00:00Z");
});

test("toRfc3339NoMillis output is valid for buildRequestDraft", () => {
  const d = new Date("2026-08-13T10:30:00Z");
  const result = toRfc3339NoMillis(d);
  const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/;
  assert.match(result, rfc3339);
  assert.ok(Number.isFinite(Date.parse(result)));
});

test("generateTimeSlots returns future-only half-hour slots for today", () => {
  const now = new Date("2026-08-13T10:15:00");
  const slots = generateTimeSlots(now, 0);
  for (const slot of slots) {
    assert.ok(slot.date > now, `slot ${slot.label} should be after now`);
  }
  assert.ok(slots.length > 0);
  assert.ok(slots.length <= 48);
});

test("generateTimeSlots for tomorrow returns all 48 slots", () => {
  const now = new Date("2026-08-13T00:00:00");
  const slots = generateTimeSlots(now, 1);
  assert.equal(slots.length, 48);
});

test("generateTimeSlots labels are HH:MM format", () => {
  const now = new Date("2026-08-13T23:00:00");
  const slots = generateTimeSlots(now, 1);
  for (const slot of slots) {
    assert.match(slot.label, /^\d{2}:\d{2}$/);
  }
});

test("missingCreateFields identifies all missing fields", () => {
  assert.deepEqual(missingCreateFields({}), ["--account", "--role", "--duration", "--justification"]);
});

test("missingCreateFields returns empty when all provided", () => {
  assert.deepEqual(
    missingCreateFields({ account: "foo", role: "bar", duration: 4, justification: "test" }),
    [],
  );
});

test("missingCreateFields detects partial missing", () => {
  assert.deepEqual(missingCreateFields({ account: "foo", role: "bar" }), ["--duration", "--justification"]);
});

test("missingCreateFields treats duration 0 as provided", () => {
  const result = missingCreateFields({ account: "a", role: "b", duration: 0, justification: "j" });
  assert.deepEqual(result, []);
});
