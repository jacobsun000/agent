import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);
const portSchema = z.int().min(1).max(65535);

const configSchema = z.object({
  provider: z.object({
    name: z.literal("openai"),
    apiKey: nonEmptyString,
    model: nonEmptyString
  }),
  memory: z
    .object({
      dbPath: z.string().trim().min(1).optional(),
      chatModel: nonEmptyString.optional(),
      embeddingModel: nonEmptyString.optional(),
      recentMessageLimit: z.int().min(1).optional(),
      consolidationBufferMessages: z.int().min(1).optional(),
      contextTokenLimit: z.int().min(1024).optional(),
      responseTokenReserve: z.int().min(128).optional(),
      recallTopK: z.int().min(1).max(10).optional()
    })
    .optional(),
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
});

export type Config = z.infer<typeof configSchema>;

export const CONFIG_PATH = path.join(
  homedir(),
  ".config",
  "agent",
  "config.jsonc"
);

const TEMPLATE_PATH = path.resolve(process.cwd(), "templates", "config.jsonc");

export function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(
      `Missing config file at ${CONFIG_PATH}. Start from ${TEMPLATE_PATH}.`
    );
  }

  const rawConfig = readFileSync(CONFIG_PATH, "utf8");
  const parseErrors: ParseError[] = [];
  const parsed = parse(rawConfig, parseErrors, {
    allowTrailingComma: true,
    disallowComments: false
  });

  if (parseErrors.length > 0) {
    const details = parseErrors
      .map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`)
      .join(", ");
    throw new Error(`Failed to parse ${CONFIG_PATH}: ${details}`);
  }

  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => {
        const issuePath = issue.path.length > 0 ? issue.path.join(".") : "root";
        return `${issuePath}: ${issue.message}`;
      })
      .join("; ");

    throw new Error(`Invalid config at ${CONFIG_PATH}: ${details}`);
  }

  return result.data;
}
