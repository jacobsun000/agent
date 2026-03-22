import { tool } from "ai";
import { z } from "zod";

import { guiService } from "@/services/gui";

const guiInputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("move_mouse"),
    id: z.string().trim().min(1).optional(),
    x: z.number().finite(),
    y: z.number().finite()
  }),
  z.object({
    action: z.literal("click"),
    id: z.string().trim().min(1).optional(),
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
    button: z.enum(["left", "middle", "right"]).optional(),
    double: z.boolean().optional()
  }),
  z.object({
    action: z.literal("type"),
    id: z.string().trim().min(1).optional(),
    text: z.string(),
    delayMs: z.number().int().nonnegative().max(1000).optional()
  }),
  z.object({
    action: z.literal("press_keys"),
    id: z.string().trim().min(1).optional(),
    keys: z.array(z.string().trim().min(1)).min(1)
  }),
  z.object({
    action: z.literal("scroll"),
    id: z.string().trim().min(1).optional(),
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
    scrollX: z.number().finite().optional(),
    scrollY: z.number().finite().optional()
  })
]);

export function createGuiInputTool() {
  return tool({
    title: "gui_input",
    description: "Send mouse and keyboard input into a running headless GUI session.",
    inputSchema: guiInputSchema,
    async execute(input) {
      switch (input.action) {
        case "move_mouse":
          return guiService.moveMouse(input);
        case "click":
          return guiService.clickMouse(input);
        case "type":
          return guiService.typeText(input);
        case "press_keys":
          return guiService.pressKeys(input);
        case "scroll":
          return guiService.scroll(input);
      }
    }
  });
}
