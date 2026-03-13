import { tool } from "ai";
import { z } from "zod";

import { createLogger } from "@/utils/logger";

const logger = createLogger("tool:sub-agent");

type SubAgentToolConfig = {
  onSpawn: (input: { label: string; task: string }) => Promise<void>;
};

export const subAgentInputSchema = z.object({
  label: z.string().trim().min(1, "Label must not be empty."),
  task: z.string().trim().min(1, "Task must not be empty.")
});

export function createSubAgentTool(config: SubAgentToolConfig) {
  return tool({
    title: "sub_agent",
    description: "Delegate a task to a background sub-agent. Use this when a self-contained task can be completed independently and reported back later. The sub agent will run in the background and report back to you once completed.",
    inputSchema: subAgentInputSchema,
    async execute({ label, task }) {
      void config.onSpawn({ label, task }).catch((error) => {
        logger.error(error instanceof Error ? error.message : error);
      });

      return {
        status: "started" as const,
        label
      };
    }
  });
}
