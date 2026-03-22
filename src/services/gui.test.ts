import test from "node:test";
import assert from "node:assert/strict";

import { guiService } from "@/services/gui";

test("gui doctor reports dependency keys", async () => {
  const result = await guiService.doctor();

  assert.equal(typeof result.ok, "boolean");
  assert.equal(typeof result.dependencies.Xvfb, "boolean");
  assert.equal(typeof result.dependencies.xdotool, "boolean");
  assert.equal(typeof result.dependencies.import, "boolean");
  assert.equal(typeof result.dependencies.xrandr, "boolean");
});
