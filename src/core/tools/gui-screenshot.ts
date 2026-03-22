import { tool } from "ai";
import { z } from "zod";

import { guiService } from "@/services/gui";

const guiScreenshotInputSchema = z.object({
  id: z.string().trim().min(1).optional(),
  label: z.string().trim().min(1).optional()
});

export function createGuiScreenshotTool() {
  return tool({
    title: "gui_screenshot",
    description: "Capture a screenshot from a running headless GUI session. Prefer taking a fresh screenshot before and after important GUI actions.",
    inputSchema: guiScreenshotInputSchema,
    async execute(input) {
      return guiService.captureScreenshot(input);
    },
    toModelOutput({ output }) {
      return {
        type: "content",
        value: [{
          type: "media",
          data: output.data,
          mediaType: output.mediaType
        }]
      };
    }
  });
}
