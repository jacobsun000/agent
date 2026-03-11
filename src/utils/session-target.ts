import { type ChannelName } from "@/channels/types";

export type SessionTarget = {
  channel: ChannelName;
  chatId: string;
};

export const DEFERRED_TELEGRAM_REPORT_SESSION = "telegram:__AGENT_DEFAULT_SESSION_UNINITIALIZED__";

export function isDeferredSessionTarget(value: string): boolean {
  return value.trim() === DEFERRED_TELEGRAM_REPORT_SESSION;
}

export function parseSessionTarget(value: string, configKey: string): SessionTarget {
  const separatorIndex = value.indexOf(":");
  if (separatorIndex === -1) {
    throw new Error(`Invalid ${configKey} '${value}'. Expected '<channel>:<chatId>'.`);
  }

  const channel = value.slice(0, separatorIndex).trim();
  const chatId = value.slice(separatorIndex + 1).trim();
  if ((channel !== "http" && channel !== "telegram") || chatId === "") {
    throw new Error(`Invalid ${configKey} '${value}'. Expected '<channel>:<chatId>'.`);
  }

  return {
    channel,
    chatId
  };
}

export function resolveSessionTarget(value: string, configKey: string): SessionTarget | undefined {
  if (isDeferredSessionTarget(value)) {
    return undefined;
  }

  return parseSessionTarget(value, configKey);
}
