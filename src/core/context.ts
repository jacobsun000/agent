import { appendFile } from "node:fs/promises";
import path from "node:path";
import { type ModelMessage } from "ai";

import { CONFIG_PATH } from "@/utils/utils";

const HISTORY_PATH = path.join(CONFIG_PATH, "workspace", "memory", "history");

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
  clear(sessionId?: string): void;
}

export class FileSystemContext implements Context {
  private readonly messagesBySession = new Map<string, ModelMessage[]>();

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
    sessionMessages.push(...messages);
    this.messagesBySession.set(key, sessionMessages);
    await this.log(messages);
  }

  clear(sessionId?: string): void {
    this.messagesBySession.delete(getSessionKey(sessionId));
  }

  private async log(messages: ModelMessage[]): Promise<void> {
    const now = new Date();
    const { day, minute } = formatDateParts(now);
    const historyFilePath = path.join(HISTORY_PATH, `${day}.md`);
    const logEntry = messages.map((message) => serializeMessage(message, minute)).join("\n");

    await appendFile(historyFilePath, logEntry, "utf8");
  }
}
