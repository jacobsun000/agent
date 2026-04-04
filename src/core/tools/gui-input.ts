import { tool } from "ai";
import { z } from "zod";

import { guiService } from "@/services/gui";

const guiInputSchema = z.object({
  action: z.enum(["move_mouse", "click", "type", "press_keys", "scroll"]),
  id: z.string().trim().min(1).optional(),
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  button: z.enum(["left", "middle", "right"]).optional(),
  double: z.boolean().optional(),
  text: z.string().optional(),
  delayMs: z.number().int().nonnegative().max(1000).optional(),
  keys: z.array(z.string().trim().min(1)).min(1).optional(),
  scrollX: z.number().finite().optional(),
  scrollY: z.number().finite().optional()
}).superRefine((value, context) => {
  switch (value.action) {
    case "move_mouse":
      if (value.x === undefined) {
        context.addIssue({ code: "custom", path: ["x"], message: "`x` is required for move_mouse." });
      }
      if (value.y === undefined) {
        context.addIssue({ code: "custom", path: ["y"], message: "`y` is required for move_mouse." });
      }
      return;
    case "click":
      return;
    case "type":
      if (value.text === undefined) {
        context.addIssue({ code: "custom", path: ["text"], message: "`text` is required for type." });
      }
      return;
    case "press_keys":
      if (!value.keys || value.keys.length === 0) {
        context.addIssue({ code: "custom", path: ["keys"], message: "`keys` is required for press_keys." });
      }
      return;
    case "scroll":
      return;
  }
});

export function createGuiInputTool() {
  return tool({
    title: "gui_input",
    description: "Send mouse and keyboard input into a running headless GUI session.",
    inputSchema: guiInputSchema,
    async execute(input) {
      switch (input.action) {
        case "move_mouse":
          return guiService.moveMouse({
            id: input.id,
            x: input.x!,
            y: input.y!
          });
        case "click":
          return guiService.clickMouse({
            id: input.id,
            x: input.x,
            y: input.y,
            button: input.button,
            double: input.double
          });
        case "type":
          return guiService.typeText({
            id: input.id,
            text: input.text!,
            delayMs: input.delayMs
          });
        case "press_keys":
          return guiService.pressKeys({
            id: input.id,
            keys: input.keys!
          });
        case "scroll":
          return guiService.scroll({
            id: input.id,
            x: input.x,
            y: input.y,
            scrollX: input.scrollX,
            scrollY: input.scrollY
          });
      }
    }
  });
}
