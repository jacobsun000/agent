import { tool } from "ai";
import { z } from "zod";

const cronActionSchema = z.enum(["add", "list", "remove"]);

export const cronInputSchema = z.object({
  action: cronActionSchema,
  message: z.string().trim().optional(),
  every_seconds: z.int().positive().optional(),
  cron_expr: z.string().trim().optional(),
  tz: z.string().trim().optional(),
  at: z.string().trim().optional(),
  job_id: z.string().trim().optional()
}).superRefine((value, context) => {
  if (value.action === "list") {
    return;
  }

  if (value.action === "remove") {
    if (!value.job_id) {
      context.addIssue({
        code: "custom",
        path: ["job_id"],
        message: "job_id is required for remove."
      });
    }
    return;
  }

  if (!value.message) {
    context.addIssue({
      code: "custom",
      path: ["message"],
      message: "message is required for add."
    });
  }

  const scheduleFields = [value.every_seconds, value.cron_expr, value.at].filter((entry) => entry !== undefined);
  if (scheduleFields.length !== 1) {
    context.addIssue({
      code: "custom",
      path: ["action"],
      message: "Add requires exactly one of every_seconds, cron_expr, or at."
    });
  }

  if (value.cron_expr && !value.tz) {
    context.addIssue({
      code: "custom",
      path: ["tz"],
      message: "tz is required when cron_expr is provided."
    });
  }

  if (!value.cron_expr && value.tz) {
    context.addIssue({
      code: "custom",
      path: ["tz"],
      message: "tz is only valid with cron_expr."
    });
  }
});

export type CronToolInput = z.infer<typeof cronInputSchema>;

type CronToolConfig = {
  enabled: boolean;
  onAction: (input: CronToolInput) => Promise<unknown>;
};

export function createCronTool(config: CronToolConfig) {
  return tool({
    title: "cron",
    description: config.enabled
      ? "Manage scheduled jobs persisted in <workspace>/crons.json. Use add for precise schedules or reminders, list to inspect jobs, and remove to delete a job."
      : "Unavailable in this context.",
    inputSchema: cronInputSchema,
    async execute(input) {
      if (!config.enabled) {
        throw new Error("The cron tool is unavailable in this context.");
      }

      return config.onAction(input);
    }
  });
}
