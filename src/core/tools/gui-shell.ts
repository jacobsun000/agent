import { tool } from "ai";
import { z } from "zod";

import { guiService } from "@/services/gui";

const guiShellInputSchema = z.object({
  id: z.string().trim().min(1).optional(),
  command: z.string().trim().min(1)
});

export function createGuiShellTool() {
  return tool({
    title: "gui_shell",
    description: "Run a shell command inside a GUI session with DISPLAY preconfigured. Useful for launching apps inside Xvfb.",
    inputSchema: guiShellInputSchema,
    async execute(input) {
      return guiService.runInSession(input.id, input.command);
    }
  });
}
