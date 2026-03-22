import test from "node:test";
import assert from "node:assert/strict";

import { cronInputSchema } from "@/core/tools/cron";

test("cron add accepts one-time at with timezone", () => {
  const result = cronInputSchema.safeParse({
    action: "add",
    message: "Run once",
    at: "2026-03-22T10:30:00",
    tz: "America/Chicago"
  });

  assert.equal(result.success, true);
  if (!result.success) {
    return;
  }

  assert.equal(result.data.at, "2026-03-22T10:30:00");
  assert.equal(result.data.tz, "America/Chicago");
});

test("cron add keeps an explicit epoch at value", () => {
  const result = cronInputSchema.safeParse({
    action: "add",
    message: "Run at epoch",
    at: "1970-01-01T00:00:00Z"
  });

  assert.equal(result.success, true);
  if (!result.success) {
    return;
  }

  assert.equal(result.data.at, "1970-01-01T00:00:00Z");
});

test("cron add accepts every_seconds when other schedule fields are blank", () => {
  const result = cronInputSchema.safeParse({
    action: "add",
    message: "Repeat",
    every_seconds: 30,
    cron_expr: "",
    at: "   "
  });

  assert.equal(result.success, true);
  if (!result.success) {
    return;
  }

  assert.equal(result.data.every_seconds, 30);
  assert.equal(result.data.cron_expr, undefined);
  assert.equal(result.data.at, undefined);
});

test("cron add accepts cron_expr and tz when at is blank", () => {
  const result = cronInputSchema.safeParse({
    action: "add",
    message: "Morning run",
    cron_expr: "0 9 * * *",
    tz: "America/Chicago",
    at: ""
  });

  assert.equal(result.success, true);
  if (!result.success) {
    return;
  }

  assert.equal(result.data.cron_expr, "0 9 * * *");
  assert.equal(result.data.tz, "America/Chicago");
  assert.equal(result.data.at, undefined);
});

test("cron add accepts at when cron_expr is blank", () => {
  const result = cronInputSchema.safeParse({
    action: "add",
    message: "One shot",
    cron_expr: "",
    at: "2026-03-22T10:30:00Z"
  });

  assert.equal(result.success, true);
  if (!result.success) {
    return;
  }

  assert.equal(result.data.cron_expr, undefined);
  assert.equal(result.data.at, "2026-03-22T10:30:00Z");
});

test("cron add rejects multiple schedule fields when both are actually provided", () => {
  const result = cronInputSchema.safeParse({
    action: "add",
    message: "Invalid schedule",
    every_seconds: 30,
    cron_expr: "0 9 * * *",
    tz: "America/Chicago"
  });

  assert.equal(result.success, false);
  if (result.success) {
    return;
  }

  assert.match(result.error.issues[0]?.message ?? "", /exactly one of every_seconds, cron_expr, or at/i);
});
