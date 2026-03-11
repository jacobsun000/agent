import { type ChannelName } from "@/channels/types";

export type SessionTarget = {
  channel: ChannelName;
  chatId: string;
};

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
