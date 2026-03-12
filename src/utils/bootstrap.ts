import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { applyEdits, modify, parse } from "jsonc-parser";

import { DEFERRED_TELEGRAM_REPORT_SESSION } from "@/utils/session-target";
import { CONFIG_PATH, pathExists } from "@/utils/utils";

const TEMPLATE_ROOT = path.resolve(process.cwd(), "templates");
const CONFIG_TEMPLATE_PATH = path.join(TEMPLATE_ROOT, "config.jsonc");
const CONFIG_FILE_PATH = path.join(CONFIG_PATH, "config.jsonc");
const WORKSPACE_PATH = path.join(CONFIG_PATH, "workspace");
const MEMORY_PATH = path.join(WORKSPACE_PATH, "memory");
const HISTORY_PATH = path.join(MEMORY_PATH, "history");
const NOTES_PATH = path.join(MEMORY_PATH, "notes");
const JSONC_FORMATTING_OPTIONS = {
  insertSpaces: true,
  tabSize: 2
} as const;

async function copyMissingTree(sourcePath: string, destinationPath: string): Promise<void> {
  const entries = await readdir(sourcePath, { withFileTypes: true });
  await mkdir(destinationPath, { recursive: true });

  for (const entry of entries) {
    const sourceEntryPath = path.join(sourcePath, entry.name);
    const destinationEntryPath = path.join(destinationPath, entry.name);

    if (entry.isDirectory()) {
      await copyMissingTree(sourceEntryPath, destinationEntryPath);
      continue;
    }

    if (await pathExists(destinationEntryPath)) {
      continue;
    }

    await copyFile(sourceEntryPath, destinationEntryPath);
  }
}

export async function bootstrapWorkspace(): Promise<void> {
  await mkdir(CONFIG_PATH, { recursive: true });
  await copyMissingTree(TEMPLATE_ROOT, CONFIG_PATH);
  await mkdir(HISTORY_PATH, { recursive: true });
  await mkdir(NOTES_PATH, { recursive: true });
}

export async function bootstrapConfigInteractive(): Promise<void> {
  await mkdir(CONFIG_PATH, { recursive: true });

  const templateText = await readFile(CONFIG_TEMPLATE_PATH, "utf8");
  const existingConfigText = await pathExists(CONFIG_FILE_PATH)
    ? await readFile(CONFIG_FILE_PATH, "utf8")
    : null;
  const existingConfig = existingConfigText ? parse(existingConfigText) as Record<string, unknown> : null;
  const templateConfig = parse(templateText) as Record<string, unknown>;
  const hasExistingSecrets = hasConfiguredSecrets(existingConfig);

  const prompt = new InteractivePrompt();

  try {
    prompt.writeLine("This will initialize ~/.agent/config.jsonc for local use.");
    prompt.writeLine("Only the config file will contain the API keys you enter.");
    prompt.writeLine("");

    if (hasExistingSecrets) {
      const overwrite = await prompt.confirm(
        "A configured ~/.agent/config.jsonc already exists. Overwrite it?",
        false
      );

      if (!overwrite) {
        prompt.writeLine("Bootstrap cancelled.");
        return;
      }

      prompt.writeLine("");
    }

    const existingOpenAIKey = getProviderApiKey(existingConfig, "openai");
    const openAIKey = await promptRequiredSecret({
      prompt,
      label: existingOpenAIKey ? "OpenAI API key (press Enter to keep existing): " : "OpenAI API key: ",
      existingValue: existingOpenAIKey
    });

    const existingTelegramEnabled = getTelegramEnabled(existingConfig, templateConfig);
    const enableTelegram = await prompt.confirm(
      "Configure Telegram now?",
      existingTelegramEnabled
    );

    let telegramToken = "";
    if (enableTelegram) {
      const existingTelegramToken = getTelegramToken(existingConfig);
      telegramToken = await promptRequiredSecret({
        prompt,
        label: existingTelegramToken
          ? "Telegram bot token (press Enter to keep existing): "
          : "Telegram bot token: ",
        existingValue: existingTelegramToken
      });
    }

    const baseText = existingConfigText ?? templateText;
    const nextConfigText = updateConfigText(baseText, {
      openAIKey,
      telegramEnabled: enableTelegram,
      telegramToken
    });

    await writeFile(CONFIG_FILE_PATH, nextConfigText, "utf8");

    prompt.writeLine("");
    prompt.writeLine(`Wrote ${CONFIG_FILE_PATH}.`);
    if (!enableTelegram) {
      prompt.writeLine("Telegram was left disabled. You can re-run `agent bootstrap` later to add it.");
    } else {
      prompt.writeLine("Heartbeat and cron will wait for the first approved Telegram chat before choosing a default report session.");
    }
    prompt.writeLine("Next step: start the gateway with `agent gateway run`.");
  } finally {
    prompt.close();
  }
}

function updateConfigText(
  sourceText: string,
  values: {
    openAIKey: string;
    telegramEnabled: boolean;
    telegramToken: string;
  }
): string {
  const parsed = parse(sourceText) as Record<string, unknown>;
  const providerIndex = findProviderIndex(parsed, "openai");
  const providersLength = Array.isArray(parsed.providers) ? parsed.providers.length : 0;
  const nextProviderIndex = providerIndex >= 0 ? providerIndex : providersLength;
  const edits = [
    ...modify(sourceText, ["providers", nextProviderIndex, "name"], "openai", {
      formattingOptions: JSONC_FORMATTING_OPTIONS
    }),
    ...modify(sourceText, ["providers", nextProviderIndex, "apiKey"], values.openAIKey, {
      formattingOptions: JSONC_FORMATTING_OPTIONS
    }),
    ...modify(sourceText, ["channels", "telegram", "enabled"], values.telegramEnabled, {
      formattingOptions: JSONC_FORMATTING_OPTIONS
    }),
    ...modify(sourceText, ["channels", "telegram", "token"], values.telegramToken, {
      formattingOptions: JSONC_FORMATTING_OPTIONS
    }),
    ...(values.telegramEnabled
      ? modify(sourceText, ["heartbeat", "reportSession"], DEFERRED_TELEGRAM_REPORT_SESSION, {
          formattingOptions: JSONC_FORMATTING_OPTIONS
        })
      : []),
    ...(values.telegramEnabled
      ? modify(sourceText, ["cron", "reportSession"], DEFERRED_TELEGRAM_REPORT_SESSION, {
          formattingOptions: JSONC_FORMATTING_OPTIONS
        })
      : [])
  ];

  return applyEdits(sourceText, edits);
}

function findProviderIndex(value: Record<string, unknown> | null, providerName: string): number {
  const providers = Array.isArray(value?.providers) ? value.providers : [];
  const index = providers.findIndex((provider) => {
    if (!provider || typeof provider !== "object") {
      return false;
    }

    return (provider as { name?: unknown }).name === providerName;
  });

  return index;
}

function hasConfiguredSecrets(value: Record<string, unknown> | null): boolean {
  const providerApiKey = getAnyProviderApiKey(value);
  const telegramEnabled = getTelegramEnabled(value, null);
  const telegramToken = getTelegramToken(value);

  return providerApiKey !== null || (telegramEnabled && telegramToken !== null);
}

function getProviderApiKey(value: Record<string, unknown> | null, providerName: string): string | null {
  const providers = Array.isArray(value?.providers) ? value.providers : [];

  for (const provider of providers) {
    if (!provider || typeof provider !== "object") {
      continue;
    }

    const typedProvider = provider as {
      name?: unknown;
      apiKey?: unknown;
    };

    if (typedProvider.name !== providerName || typeof typedProvider.apiKey !== "string") {
      continue;
    }

    const apiKey = typedProvider.apiKey.trim();
    if (apiKey !== "" && !isPlaceholderApiKey(apiKey)) {
      return apiKey;
    }
  }

  return null;
}

function getAnyProviderApiKey(value: Record<string, unknown> | null): string | null {
  const providers = Array.isArray(value?.providers) ? value.providers : [];

  for (const provider of providers) {
    if (!provider || typeof provider !== "object") {
      continue;
    }

    const apiKey = (provider as { apiKey?: unknown }).apiKey;
    if (typeof apiKey !== "string") {
      continue;
    }

    const trimmed = apiKey.trim();
    if (trimmed !== "" && !isPlaceholderApiKey(trimmed)) {
      return trimmed;
    }
  }

  return null;
}

function isPlaceholderApiKey(value: string): boolean {
  return value === "sk-..." || value === "sk-or-...";
}

function getTelegramEnabled(
  value: Record<string, unknown> | null,
  fallbackValue: Record<string, unknown> | null
): boolean {
  const channelConfig = getTelegramChannelConfig(value) ?? getTelegramChannelConfig(fallbackValue);
  return channelConfig?.enabled === true;
}

function getTelegramToken(value: Record<string, unknown> | null): string | null {
  const channelConfig = getTelegramChannelConfig(value);
  if (!channelConfig || typeof channelConfig.token !== "string") {
    return null;
  }

  const token = channelConfig.token.trim();
  if (token === "" || token === "123456:telegram-bot-token") {
    return null;
  }

  return token;
}

function getTelegramChannelConfig(
  value: Record<string, unknown> | null
): { enabled?: boolean; token?: string } | null {
  const channels = value?.channels;
  if (!channels || typeof channels !== "object") {
    return null;
  }

  const telegram = (channels as { telegram?: unknown }).telegram;
  if (!telegram || typeof telegram !== "object") {
    return null;
  }

  return telegram as { enabled?: boolean; token?: string };
}

async function promptRequiredSecret(input: {
  prompt: InteractivePrompt;
  label: string;
  existingValue: string | null;
}): Promise<string> {
  while (true) {
    const value = (await input.prompt.askSecret(input.label)).trim();

    if (value !== "") {
      return value;
    }

    if (input.existingValue) {
      return input.existingValue;
    }

    input.prompt.writeLine("A value is required.");
  }
}

class InteractivePrompt {
  private readonly readline = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  writeLine(message: string) {
    process.stdout.write(`${message}\n`);
  }

  async ask(question: string): Promise<string> {
    return new Promise((resolve) => {
      this.readline.question(question, (answer) => {
        resolve(answer);
      });
    });
  }

  async askSecret(question: string): Promise<string> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      return this.ask(question);
    }

    this.readline.pause();
    process.stdout.write(question);

    return new Promise((resolve, reject) => {
      const stdin = process.stdin;
      const wasRaw = stdin.isRaw;
      let value = "";

      const cleanup = () => {
        stdin.off("data", onData);
        stdin.setRawMode(Boolean(wasRaw));
        stdin.pause();
        this.readline.resume();
      };

      const onData = (chunk: string | Buffer) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");

        for (const character of text) {
          if (character === "\u0003") {
            cleanup();
            reject(new Error("Bootstrap cancelled."));
            return;
          }

          if (character === "\r" || character === "\n") {
            cleanup();
            process.stdout.write("\n");
            resolve(value);
            return;
          }

          if (character === "\u0008" || character === "\u007f") {
            value = value.slice(0, -1);
            continue;
          }

          if (character >= " ") {
            value += character;
          }
        }
      };

      stdin.resume();
      stdin.setRawMode(true);
      stdin.on("data", onData);
    });
  }

  async confirm(question: string, defaultValue: boolean): Promise<boolean> {
    const suffix = defaultValue ? " [Y/n] " : " [y/N] ";

    while (true) {
      const answer = (await this.ask(`${question}${suffix}`)).trim().toLowerCase();
      if (answer === "") {
        return defaultValue;
      }

      if (answer === "y" || answer === "yes") {
        return true;
      }

      if (answer === "n" || answer === "no") {
        return false;
      }

      this.writeLine("Please answer yes or no.");
    }
  }

  close() {
    this.readline.close();
    process.stdin.pause();
  }
}
