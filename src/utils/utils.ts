import { access } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { type ContextStatistics } from "@/core/context";

export const CONFIG_PATH = path.join(
  homedir(),
  ".agent",
);

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

export function escapeTelegramMarkdownV2(value: string): string {
  return value.replaceAll(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

export function formatContextStatisticsMarkdown(stats: ContextStatistics): string {
  const successRate = stats.toolCallSuccessRate === null
    ? "n/a"
    : `${(stats.toolCallSuccessRate * 100).toFixed(1)}%`;

  return [
    "*Session Statistics*",
    `session: ${escapeTelegramMarkdownV2(stats.sessionId)}`,
    `total messages: ${stats.totalMessages}`,
    `user messages: ${stats.totalUserMessages}`,
    `model messages: ${stats.totalModelMessages}`,
    `system messages: ${stats.totalSystemMessages}`,
    `tool messages: ${stats.totalToolMessages}`,
    `total tool calls: ${stats.totalToolCalls}`,
    `tool successes: ${stats.totalToolCallSuccesses}`,
    `tool failures: ${stats.totalToolCallFailures}`,
    `tool success rate: ${escapeTelegramMarkdownV2(successRate)}`,
    `total input tokens: ${stats.totalInputTokens}${stats.inputTokensEstimated ? " \\(estimated\\)" : ""}`,
    `total output tokens: ${stats.totalOutputTokens}${stats.outputTokensEstimated ? " \\(estimated\\)" : ""}`
  ].join("\n");
}

export function formatSessionStatsMarkdownMessage(message: string): string {
  return [
    "*Session Statistics*",
    escapeTelegramMarkdownV2(message)
  ].join("\n");
}
