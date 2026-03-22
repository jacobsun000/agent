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
