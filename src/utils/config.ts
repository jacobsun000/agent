import { existsSync, readFileSync } from "node:fs";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { z } from "zod";
import path from "node:path";

import { CONFIG_PATH } from "@/utils/utils";
import { DEFERRED_TELEGRAM_REPORT_SESSION, isDeferredSessionTarget } from "@/utils/session-target";

export const CONFIG_FILE_PATH = path.join(CONFIG_PATH, "config.jsonc");

const nonEmptyString = z.string().trim().min(1);
const portSchema = z.int().min(1).max(65535);
const providerSchema = z.discriminatedUnion("name", [
  z.object({
    name: z.literal("openai"),
    apiKey: nonEmptyString
  }),
  z.object({
    name: z.literal("openrouter"),
    apiKey: nonEmptyString
  }),
  z.object({
    name: z.literal("codex"),
    apiKey: z.string().default("")
  })
]);
const secondsStringSchema = z
  .string()
  .trim()
  .regex(/^\d+$/, "Must be an integer number of seconds.")
  .refine((value) => Number(value) > 0, "Must be greater than 0.");
const sessionTargetSchema = z.string().trim().refine(
  (value) => isDeferredSessionTarget(value) || /^(http|telegram):.+$/.test(value),
  {
    message: "Must be in the format '<channel>:<chatId>' or the deferred default-session sentinel."
  }
);

const configSchema = z.object({
  agent: z.object({
    model: nonEmptyString,
    transcriptionModel: nonEmptyString.default("openai/gpt-4o-mini-transcribe"),
    memoryWindow: z.int().positive().optional(),
    enableStream: z.boolean().default(false)
  }),
  subagent: z.object({
    model: nonEmptyString,
    maxIterations: z.int().positive().optional(),
  }),
  heartbeat: z
    .object({
      model: nonEmptyString.default("openai/gpt-5-mini"),
      interval: secondsStringSchema.default("1800"),
      reportSession: sessionTargetSchema
    })
    .default({
      model: "openai/gpt-5-mini",
      interval: "1800",
      reportSession: DEFERRED_TELEGRAM_REPORT_SESSION
    }),
  web: z.object({
    tavilyApiKey: nonEmptyString
  }),
  cron: z
    .object({
      reportSession: sessionTargetSchema
    })
    .default({
      reportSession: DEFERRED_TELEGRAM_REPORT_SESSION
    }),
  updater: z
    .object({
      enabled: z.boolean().default(false),
      interval: secondsStringSchema.default("300"),
      remote: nonEmptyString.default("origin"),
      branch: nonEmptyString.optional(),
      installDependencies: z.boolean().default(true),
      restartOnUpdate: z.boolean().default(true),
      repoRoot: nonEmptyString.optional()
    })
    .default({
      enabled: false,
      interval: "300",
      remote: "origin",
      installDependencies: true,
      restartOnUpdate: true
    }),
  providers: z.array(providerSchema),
  channels: z.object({
    http: z.object({
      enabled: z.literal(true),
      host: nonEmptyString,
      port: portSchema,
      url: z.url().trim().min(1)
    }),
    telegram: z
      .object({
        enabled: z.boolean(),
        token: z.string()
      })
      .superRefine((value, context) => {
        if (value.enabled && value.token.trim() === "") {
          context.addIssue({
            code: "custom",
            path: ["token"],
            message: "Must be non-empty when Telegram is enabled."
          });
        }
      })
  })
}).superRefine((value, context) => {
  const seenProviders = new Set<string>();

  for (const [index, provider] of value.providers.entries()) {
    if (seenProviders.has(provider.name)) {
      context.addIssue({
        code: "custom",
        path: ["providers", index, "name"],
        message: `Duplicate provider '${provider.name}'.`
      });
      continue;
    }

    seenProviders.add(provider.name);
  }

  try {
    const providerName = getProviderNameFromModel(value.agent.model);
    if (!seenProviders.has(providerName)) {
      context.addIssue({
        code: "custom",
        path: ["agent", "model"],
        message: `No provider named '${providerName}' configured in providers.`
      });
    }
  } catch (error) {
    context.addIssue({
      code: "custom",
      path: ["agent", "model"],
      message: error instanceof Error ? error.message : "Invalid model format."
    });
  }

  try {
    const transcriptionProviderName = getProviderNameFromModel(value.agent.transcriptionModel);
    if (!seenProviders.has(transcriptionProviderName)) {
      context.addIssue({
        code: "custom",
        path: ["agent", "transcriptionModel"],
        message: `No provider named '${transcriptionProviderName}' configured in providers.`
      });
    }
  } catch (error) {
    context.addIssue({
      code: "custom",
      path: ["agent", "transcriptionModel"],
      message: error instanceof Error ? error.message : "Invalid model format."
    });
  }

  try {
    const heartbeatProviderName = getProviderNameFromModel(value.heartbeat.model);
    if (!seenProviders.has(heartbeatProviderName)) {
      context.addIssue({
        code: "custom",
        path: ["heartbeat", "model"],
        message: `No provider named '${heartbeatProviderName}' configured in providers.`
      });
    }
  } catch (error) {
    context.addIssue({
      code: "custom",
      path: ["heartbeat", "model"],
      message: error instanceof Error ? error.message : "Invalid model format."
    });
  }
});

export type Config = z.infer<typeof configSchema>;
export type ProviderConfig = Config["providers"][number];

export function getProviderNameFromModel(model: string): string {
  const trimmed = model.trim();
  if (trimmed === "") {
    throw new Error("Model must be non-empty.");
  }

  const separatorIndex = trimmed.indexOf("/");
  if (separatorIndex === -1) {
    throw new Error("Model must be in the format '<provider>/<model>'.");
  }

  const provider = trimmed.slice(0, separatorIndex).trim();
  if (provider === "") {
    throw new Error("Model must start with '<provider>/'.");
  }

  return provider;
}

export function getProviderConfig(config: Config, model = config.agent.model): ProviderConfig {
  const providerName = getProviderNameFromModel(model);
  const provider = config.providers.find((entry) => entry.name === providerName);

  if (!provider) {
    throw new Error(`No provider named '${providerName}' configured.`);
  }

  return provider;
}

export function loadConfig(): Config {
  if (!existsSync(CONFIG_FILE_PATH)) {
    throw new Error(`Missing config file at ${CONFIG_FILE_PATH}.`);
  }

  const rawConfig = readFileSync(CONFIG_FILE_PATH, "utf8");
  const parseErrors: ParseError[] = [];
  const parsed = parse(rawConfig, parseErrors, {
    allowTrailingComma: true,
    disallowComments: false
  });

  if (parseErrors.length > 0) {
    const details = parseErrors
      .map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`)
      .join(", ");
    throw new Error(`Failed to parse ${CONFIG_FILE_PATH}: ${details}`);
  }

  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => {
        const issuePath = issue.path.length > 0 ? issue.path.join(".") : "root";
        return `${issuePath}: ${issue.message}`;
      })
      .join("; ");

    throw new Error(`Invalid config at ${CONFIG_FILE_PATH}: ${details}`);
  }

  return result.data;
}
