import { appendFile } from "node:fs/promises";
import path from "node:path";
import { generateText, type ModelMessage } from "ai";

import { compactContext } from "@/core/compact";
import { WORKSPACE_PATH } from "@/utils/utils";
import { formatDateParts, serializeMessage } from "@/utils/searializer";
import { getSummaryAgentModel } from "@/utils/model";

const HISTORY_PATH = path.join(WORKSPACE_PATH, "memory", "history");

type ContextConfig = {
  systemPrompt: string;
}

export class Context {
  readonly systemPrompt: string;
  private messages: ModelMessage[];

  constructor(config: ContextConfig) {
    this.systemPrompt = config.systemPrompt;
    this.messages = [];
  }

  async add(messages: ModelMessage[]) {
    this.messages.push(...messages);
    await this.log(messages);
  }

  get(): ModelMessage[] {
    return this.messages;
  }

  clear(): void {
    this.messages = [];
  }

  async getSummary(lastN: number): Promise<string> {
    const result = await generateText({
      model: getSummaryAgentModel(),
      system: "Briefly summarize the following conversation, focusing on key details and information that would be important for understanding the context. Be concise but informative.",
      messages: this.messages.slice(-lastN)
    });
    return result.text;
  }

  async compact(): Promise<void> {
    this.messages = await compactContext(this.messages)
  }

  private async log(messages: ModelMessage[]): Promise<void> {
    const now = new Date();
    const { day, minute } = formatDateParts(now);
    const historyFilePath = path.join(HISTORY_PATH, `${day}.md`);
    const logEntry = messages.map((message) => serializeMessage(message, minute)).join("\n");

    await appendFile(historyFilePath, logEntry, "utf8");
  }
}
