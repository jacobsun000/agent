import test from "node:test";
import assert from "node:assert/strict";

import { parseAtDateTime } from "@/services/cron";

test("parseAtDateTime resolves local at values with tz", () => {
  const parsed = parseAtDateTime("2026-03-22T10:30:00", "America/Chicago");

  assert.equal(parsed.toISOString(), "2026-03-22T15:30:00.000Z");
});
