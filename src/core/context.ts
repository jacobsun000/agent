import { appendFile } from "node:fs/promises";
import path from "node:path";
import { type ModelMessage } from "ai";
import OpenAI from "openai";

import { CONFIG_PATH } from "@/utils/utils";

const HISTORY_PATH = path.join(CONFIG_PATH, "workspace", "memory", "history");

export type ContextStatistics = {
  sessionId: string;
  totalMessages: number;
  totalUserMessages: number;
  totalModelMessages: number;
  totalSystemMessages: number;
  totalToolMessages: number;
  totalToolCalls: number;
  totalToolCallSuccesses: number;
  totalToolCallFailures: number;
  toolCallSuccessRate: number | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  inputTokensEstimated: boolean;
  outputTokensEstimated: boolean;
};

function formatDateParts(value: Date): { day: string; minute: string } {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  const hours = String(value.getHours()).padStart(2, "0");
  const minutes = String(value.getMinutes()).padStart(2, "0");

  return {
    day: `${year}-${month}-${day}`,
    minute: `${year}-${month}-${day} ${hours}:${minutes}`
  };
}

function serializeContent(content: ModelMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .map((part) => {
      const toolName =
        "toolName" in part && typeof part.toolName === "string" ? part.toolName : "unknown";

      if ("text" in part && typeof part.text === "string") {
        return part.text;
      }

      if ("input" in part) {
        return `[tool-call:${toolName}] ${JSON.stringify(part.input)}`;
      }

      if ("output" in part) {
        return `[tool-result:${toolName}] ${JSON.stringify(part.output)}`;
      }

      if ("errorText" in part && typeof part.errorText === "string") {
        return `[tool-error:${toolName}] ${part.errorText}`;
      }

      if ("providerExecuted" in part && "providerMetadata" in part) {
        return JSON.stringify(part);
      }

      return JSON.stringify(part);
    })
    .filter((value) => value.trim() !== "")
    .join("\n");
}

function serializeMessage(message: ModelMessage, timestamp: string): string {
  const body = serializeContent(message.content);
  const lines = body === "" ? ["[empty]"] : body.split("\n");
  return [`[${timestamp}] ${message.role}`, ...lines, ""].join("\n");
}

function getSessionKey(sessionId?: string): string {
  return sessionId ?? "default";
}

export interface Context {
  get(sessionId?: string): ModelMessage[];
  add(sessionId: string | undefined, messages: ModelMessage[]): Promise<void>;
  recordTurnUsage(
    sessionId: string | undefined,
    usage: {
      inputTokens?: number;
      outputTokens?: number;
      estimatedOutputTokens?: number;
    }
  ): void;
  statistics(sessionId?: string): ContextStatistics;
  compact(
    sessionId: string | undefined,
    options: {
      model: string;
      openAIApiKey: string;
      notify?: () => Promise<void>;
    }
  ): Promise<{
    compacted: boolean;
    message: string;
    beforeMessages: number;
    afterMessages: number;
    compactedResponseId?: string;
  }>;
  clear(sessionId?: string): void;
}

export class FileSystemContext implements Context {
  private readonly messagesBySession = new Map<string, ModelMessage[]>();
  private readonly statsBySession = new Map<string, Omit<ContextStatistics, "sessionId" | "toolCallSuccessRate">>();

  get(sessionId?: string): ModelMessage[] {
    const key = getSessionKey(sessionId);
    return [...(this.messagesBySession.get(key) ?? [])];
  }

  async add(sessionId: string | undefined, messages: ModelMessage[]): Promise<void> {
    if (messages.length === 0) {
      return;
    }

    const key = getSessionKey(sessionId);
    const sessionMessages = this.messagesBySession.get(key) ?? [];
    const stats = this.getOrCreateStats(key);

    sessionMessages.push(...messages);
    for (const message of messages) {
      this.updateStatsWithMessage(stats, message);
    }

    this.messagesBySession.set(key, sessionMessages);
    await this.log(messages);
  }

  recordTurnUsage(
    sessionId: string | undefined,
    usage: {
      inputTokens?: number;
      outputTokens?: number;
      estimatedOutputTokens?: number;
    }
  ): void {
    const key = getSessionKey(sessionId);
    const stats = this.getOrCreateStats(key);

    if (typeof usage.inputTokens === "number" && Number.isFinite(usage.inputTokens)) {
      stats.totalInputTokens = Math.max(0, Math.floor(usage.inputTokens));
      stats.inputTokensEstimated = false;
    } else {
      stats.totalInputTokens = 0;
      stats.inputTokensEstimated = true;
    }

    if (typeof usage.outputTokens === "number" && Number.isFinite(usage.outputTokens)) {
      stats.totalOutputTokens += Math.max(0, Math.floor(usage.outputTokens));
    } else if (
      typeof usage.estimatedOutputTokens === "number" &&
      Number.isFinite(usage.estimatedOutputTokens)
    ) {
      stats.totalOutputTokens += Math.max(0, Math.floor(usage.estimatedOutputTokens));
      stats.outputTokensEstimated = true;
    } else {
      stats.outputTokensEstimated = true;
    }
  }

  statistics(sessionId?: string): ContextStatistics {
    const key = getSessionKey(sessionId);
    const stats = this.statsBySession.get(key);
    if (!stats) {
      return {
        sessionId: key,
        totalMessages: 0,
        totalUserMessages: 0,
        totalModelMessages: 0,
        totalSystemMessages: 0,
        totalToolMessages: 0,
        totalToolCalls: 0,
        totalToolCallSuccesses: 0,
        totalToolCallFailures: 0,
        toolCallSuccessRate: null,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        inputTokensEstimated: false,
        outputTokensEstimated: false
      };
    }

    return {
      sessionId: key,
      ...stats,
      toolCallSuccessRate: stats.totalToolCalls > 0 ? stats.totalToolCallSuccesses / stats.totalToolCalls : null
    };
  }

  clear(sessionId?: string): void {
    const key = getSessionKey(sessionId);
    this.messagesBySession.delete(key);
    this.statsBySession.delete(key);
  }

  async compact(
    sessionId: string | undefined,
    options: {
      model: string;
      openAIApiKey: string;
      notify?: () => Promise<void>;
    }
  ): Promise<{
    compacted: boolean;
    message: string;
    beforeMessages: number;
    afterMessages: number;
    compactedResponseId?: string;
  }> {
    const key = getSessionKey(sessionId);
    const beforeMessages = (this.messagesBySession.get(key) ?? []).length;

    if (beforeMessages === 0) {
      return {
        compacted: false,
        message: "No conversation history to compact.",
        beforeMessages,
        afterMessages: 0
      };
    }

    if (options.notify) {
      await options.notify();
    }

    const messagesToCompact = this.messagesBySession.get(key) ?? [];
    const transcript = buildTranscript(messagesToCompact);

    const client = new OpenAI({
      apiKey: options.openAIApiKey
    });
    const compactedResponse = await client.responses.compact({
      model: options.model,
      input: transcript
    });

    const compactedNote: ModelMessage = {
      role: "system",
      content: [
        "Conversation memory was compacted by the system.",
        `Compaction response id: ${compactedResponse.id}`,
        "Essential long-term context should be in MEMORY.md and notes."
      ].join("\n")
    };

    const resetStats: Omit<ContextStatistics, "sessionId" | "toolCallSuccessRate"> = {
      totalMessages: 0,
      totalUserMessages: 0,
      totalModelMessages: 0,
      totalSystemMessages: 0,
      totalToolMessages: 0,
      totalToolCalls: 0,
      totalToolCallSuccesses: 0,
      totalToolCallFailures: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      inputTokensEstimated: false,
      outputTokensEstimated: false
    };

    this.messagesBySession.set(key, [compactedNote]);
    this.statsBySession.set(key, resetStats);
    this.updateStatsWithMessage(resetStats, compactedNote);
    await this.log([compactedNote]);

    return {
      compacted: true,
      message: `Compaction completed. Context is now reset to a compacted marker (response: ${compactedResponse.id}).`,
      beforeMessages: messagesToCompact.length,
      afterMessages: 1,
      compactedResponseId: compactedResponse.id
    };
  }

  private async log(messages: ModelMessage[]): Promise<void> {
    const now = new Date();
    const { day, minute } = formatDateParts(now);
    const historyFilePath = path.join(HISTORY_PATH, `${day}.md`);
    const logEntry = messages.map((message) => serializeMessage(message, minute)).join("\n");

    await appendFile(historyFilePath, logEntry, "utf8");
  }

  private getOrCreateStats(key: string): Omit<ContextStatistics, "sessionId" | "toolCallSuccessRate"> {
    const existing = this.statsBySession.get(key);
    if (existing) {
      return existing;
    }

    const initial: Omit<ContextStatistics, "sessionId" | "toolCallSuccessRate"> = {
      totalMessages: 0,
      totalUserMessages: 0,
      totalModelMessages: 0,
      totalSystemMessages: 0,
      totalToolMessages: 0,
      totalToolCalls: 0,
      totalToolCallSuccesses: 0,
      totalToolCallFailures: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      inputTokensEstimated: false,
      outputTokensEstimated: false
    };
    this.statsBySession.set(key, initial);
    return initial;
  }

  private updateStatsWithMessage(
    stats: Omit<ContextStatistics, "sessionId" | "toolCallSuccessRate">,
    message: ModelMessage
  ): void {
    const isUser = message.role === "user";
    const isSystem = message.role === "system";
    const isTool = message.role === "tool";

    stats.totalMessages += 1;
    if (isUser) {
      stats.totalUserMessages += 1;
    } else if (message.role === "assistant") {
      stats.totalModelMessages += 1;
    } else if (isSystem) {
      stats.totalSystemMessages += 1;
    } else if (isTool) {
      stats.totalToolMessages += 1;
    }

    const toolStats = extractToolStats(message);
    stats.totalToolCalls += toolStats.calls;
    stats.totalToolCallSuccesses += toolStats.successes;
    stats.totalToolCallFailures += toolStats.failures;

  }
}

function buildTranscript(messages: ModelMessage[]): string {
  return messages
    .map((message) => {
      const body = serializeContent(message.content);
      return [`[${message.role}]`, body === "" ? "[empty]" : body].join("\n");
    })
    .join("\n\n");
}

function extractToolStats(message: ModelMessage): {
  calls: number;
  successes: number;
  failures: number;
} {
  if (typeof message.content === "string") {
    return { calls: 0, successes: 0, failures: 0 };
  }

  let calls = 0;
  let successes = 0;
  let failures = 0;

  for (const part of message.content) {
    const hasToolName = "toolName" in part && typeof part.toolName === "string";
    if (!hasToolName) {
      continue;
    }

    if ("input" in part) {
      calls += 1;
    }

    if ("output" in part) {
      successes += 1;
    }

    if ("errorText" in part && typeof part.errorText === "string") {
      failures += 1;
    }
  }

  return { calls, successes, failures };
}
