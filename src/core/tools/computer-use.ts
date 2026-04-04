import { tool } from "ai";
import { z } from "zod";

import { computerService } from "@/services/computer";

const computerUseInputSchema = z.object({
  action: z.enum(["start", "resume", "status", "list", "close"]),
  sessionId: z.string().trim().min(1).optional(),
  task: z.string().trim().min(1).optional(),
  answer: z.string().trim().min(1).optional(),
  maxSteps: z.number().int().positive().max(100).optional()
}).superRefine((value, context) => {
  switch (value.action) {
    case "start":
      if (!value.task) {
        context.addIssue({
          code: "custom",
          path: ["task"],
          message: "`task` is required when action is `start`."
        });
      }
      return;
    case "resume":
      if (!value.answer) {
        context.addIssue({
          code: "custom",
          path: ["answer"],
          message: "`answer` is required when action is `resume`."
        });
      }
      return;
    case "status":
    case "list":
    case "close":
      return;
  }
});

type ComputerUseToolConfig = {
  defaultSessionId?: string;
};

export function createComputerUseTool(config: ComputerUseToolConfig = {}) {
  const resolveSessionId = (sessionId?: string) => sessionId ?? config.defaultSessionId;

  return tool({
    title: "computer_use",
    description: [
      "Run browser tasks with the native OpenAI computer-use code-execution pattern over a persistent Playwright session.",
      "Use `action: start` for a fresh website task, `resume` when the tool previously returned `status: awaiting_user`,",
      "and `status`/`list`/`close` to inspect or clean up sessions.",
      "Browser state persists in <workspace>/browser/profile across runs."
    ].join(" "),
    inputSchema: computerUseInputSchema,
    async execute(input) {
      switch (input.action) {
        case "start":
          return computerService.runTask({
            task: input.task!,
            maxSteps: input.maxSteps,
            sessionId: resolveSessionId(input.sessionId)
          });
        case "resume":
          return computerService.resumeTask({
            answer: input.answer!,
            maxSteps: input.maxSteps,
            sessionId: resolveSessionId(input.sessionId)
          });
        case "status": {
          const sessionId = resolveSessionId(input.sessionId);
          const session = await computerService.getSessionSummary(sessionId);
          return session ?? {
            sessionId: sessionId ?? "browser-default",
            found: false
          };
        }
        case "list":
          return computerService.listSessions();
        case "close":
          return computerService.closeSession(resolveSessionId(input.sessionId));
      }
    }
  });
}
