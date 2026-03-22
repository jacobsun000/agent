import { tool } from "ai";
import { z } from "zod";

const cronActionSchema = z.enum(["add", "list", "remove"]);

function normalizeOptionalCronString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return value as string | undefined;
  }

  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function hasCronScheduleValue(value: unknown): boolean {
  if (typeof value === "number") {
    return true;
  }

  return normalizeOptionalCronString(value) !== undefined;
}

export function normalizeCronInput(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const input = { ...value } as Record<string, unknown>;
  for (const key of ["message", "cron_expr", "tz", "at", "job_id"]) {
    input[key] = normalizeOptionalCronString(input[key]);
  }

  return input;
}

export const cronInputSchema = z.preprocess(normalizeCronInput, z.object({
  action: cronActionSchema.describe("Operation to perform: add, list, or remove."),
  message: z.string().trim().optional().describe("Message to send when an added job triggers."),
  every_seconds: z.int().positive().optional().describe("Repeat every N seconds. Use only for add."),
  cron_expr: z.string().trim().optional().describe("5-field cron expression for wall-clock schedules. Use only for add."),
  tz: z.string().trim().optional().describe("IANA timezone like 'UTC' or 'America/Chicago'. Required with cron_expr, optional with at."),
  at: z.string().trim().optional().describe("One-time datetime. Can be absolute like '2026-03-19T20:30:00Z' or local when used with tz."),
  job_id: z.string().trim().optional().describe("Job id to remove. Use only for remove.")
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

  const scheduleFields = [value.every_seconds, value.cron_expr, value.at].filter(hasCronScheduleValue);
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

  if (value.tz && !value.cron_expr && !value.at) {
    context.addIssue({
      code: "custom",
      path: ["tz"],
      message: "tz is only valid with cron_expr or at."
    });
  }
}));

export type CronToolInput = z.infer<typeof cronInputSchema>;

type CronToolConfig = {
  onAction: (input: CronToolInput) => Promise<unknown>;
};

export function createCronTool(config: CronToolConfig) {
  return tool({
    title: "cron",
    description: "Manage scheduled jobs in <workspace>/crons.json. Add a job with exactly one schedule mode: every_seconds, cron_expr, or at. List jobs with action='list', or delete one with action='remove' and job_id.",
    inputSchema: cronInputSchema,
    async execute(input) {
      return config.onAction(input);
    }
  });
}
