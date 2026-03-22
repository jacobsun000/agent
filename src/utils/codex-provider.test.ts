import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { serializeToolInputSchema } from "@/utils/codex-provider";

test("serializeToolInputSchema converts zod preprocess schemas to JSON Schema", () => {
  const schema = z.preprocess((value) => value, z.object({
    action: z.enum(["add", "list", "remove"]),
    at: z.string().optional(),
    tz: z.string().optional()
  }));

  const serialized = serializeToolInputSchema(schema);

  assert.equal(serialized.type, "object");
  assert.deepEqual(serialized.required, ["action"]);
  assert.ok(typeof serialized.properties === "object" && serialized.properties !== null);

  const properties = serialized.properties as Record<string, { type?: string }>;
  assert.equal(properties.at?.type, "string");
  assert.equal(properties.tz?.type, "string");
});
