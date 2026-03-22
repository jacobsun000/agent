import { tool } from "ai";
import { z } from "zod";

import { guiService } from "@/services/gui";

const guiSessionInputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("start"),
    id: z.string().trim().min(1).optional(),
    width: z.number().int().positive().max(8192).optional(),
    height: z.number().int().positive().max(8192).optional(),
    depth: z.number().int().positive().max(32).optional(),
    command: z.string().trim().min(1).optional()
  }),
  z.object({
    action: z.literal("stop"),
    id: z.string().trim().min(1).optional()
  }),
  z.object({
    action: z.literal("status"),
    id: z.string().trim().min(1).optional()
  }),
  z.object({
    action: z.literal("list")
  }),
  z.object({
    action: z.literal("doctor")
  })
]);

export function createGuiSessionTool() {
  return tool({
    title: "gui_session",
    description: "Manage headless Linux GUI sessions backed by Xvfb. Use this before GUI interaction to start, inspect, or stop a session.",
    inputSchema: guiSessionInputSchema,
    async execute(input) {
      switch (input.action) {
        case "start":
          return guiService.startSession(input);
        case "stop":
          return guiService.stopSession(input.id);
        case "status": {
          const session = await guiService.getSessionStatus(input.id);
          return session ?? { id: input.id ?? "default", active: false, found: false };
        }
        case "list":
          return guiService.listSessions();
        case "doctor":
          return guiService.doctor();
      }
    }
  });
}
