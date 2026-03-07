import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";

export type AgentConfig = {
  provider: {
    name: "openai";
    apiKey: string;
    model: string;
  };
  channels: {
    telegram: {
      enabled: boolean;
      token: string;
    };
  };
};

export const CONFIG_PATH = path.join(
  homedir(),
  ".config",
  "agent",
  "config.jsonc"
);

const TEMPLATE_PATH = path.resolve(process.cwd(), "templates", "config.jsonc");

export function loadConfig(): AgentConfig {
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

  return validateConfig(parsed);
}

function validateConfig(value: unknown): AgentConfig {
  if (!value || typeof value !== "object") {
    throw new Error("Config must be a JSON object.");
  }

  const provider = (value as { provider?: unknown }).provider;
  if (!provider || typeof provider !== "object") {
    throw new Error("Config must include a `provider` object.");
  }

  const name = (provider as { name?: unknown }).name;
  const apiKey = (provider as { apiKey?: unknown }).apiKey;
  const model = (provider as { model?: unknown }).model;

  if (name !== "openai") {
    throw new Error("Only `openai` is supported in `provider.name` for now.");
  }

  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    throw new Error("`provider.apiKey` must be a non-empty string.");
  }

  if (typeof model !== "string" || model.trim() === "") {
    throw new Error("`provider.model` must be a non-empty string.");
  }

  const channels = (value as { channels?: unknown }).channels;
  if (!channels || typeof channels !== "object") {
    throw new Error("Config must include a `channels` object.");
  }

  const telegram = (channels as { telegram?: unknown }).telegram;
  if (!telegram || typeof telegram !== "object") {
    throw new Error("Config must include a `channels.telegram` object.");
  }

  const telegramEnabled = (telegram as { enabled?: unknown }).enabled;
  const telegramToken = (telegram as { token?: unknown }).token;

  if (typeof telegramEnabled !== "boolean") {
    throw new Error("`channels.telegram.enabled` must be a boolean.");
  }

  if (typeof telegramToken !== "string") {
    throw new Error("`channels.telegram.token` must be a string.");
  }

  if (telegramEnabled && telegramToken.trim() === "") {
    throw new Error("`channels.telegram.token` must be non-empty when Telegram is enabled.");
  }

  return {
    provider: {
      name,
      apiKey,
      model
    },
    channels: {
      telegram: {
        enabled: telegramEnabled,
        token: telegramToken
      }
    }
  };
}
