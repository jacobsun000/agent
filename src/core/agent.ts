import { streamText, stepCountIs, type LanguageModel, type ModelMessage } from "ai";

import { execTool } from "@/core/tools/exec";
import { createMemoryRecallTool, createMemoryRememberTool } from "@/core/tools/memory";
import { MemoryService, type ConversationMessage, type ConversationScope } from "@/memory";
import { extractPlainTextFromModelContent } from "@/memory/utils";
import { createLogger } from "@/utils/logger";

const logger = createLogger("agent");

const SYSTEM_PROMPT = `
You are a basic personal assistant agent running in a CLI.

You have access to these tools:
- exec: execute a command through bash.
- memory_recall: search long-term memory for relevant prior context.
- memory_remember: store an important durable note in long-term memory.

Use exec when you need current local information or when the user asks you to perform an action in the repository. Prefer short, targeted commands. After using tools, summarize what you did and what happened.

Long-term memory is available, but it may be incomplete or stale. Use memory_recall for a more targeted lookup when the automatically supplied memory context is insufficient. Use memory_remember only for durable information that should help on future turns, such as user preferences, standing instructions, project facts, or recurring workflows.

When no tool is needed, answer directly. Keep answers concise and practical.
`.trim();

type AgentConfig = {
  model: LanguageModel;
  memory: MemoryService;
  maxIterations?: number;
  maxTokens?: number;
  memoryTopK?: number;
  contextTokenLimit?: number;
  responseTokenReserve?: number;
};

type RunTurnInput = {
  scope: ConversationScope;
  text: string;
  onTextDelta?: (delta: string) => void | Promise<void>;
};

export class Agent {
  private readonly model: LanguageModel;
  private readonly memory: MemoryService;
  private readonly maxIterations: number;
  private readonly maxTokens?: number;
  private readonly memoryTopK: number;
  private readonly contextTokenLimit?: number;
  private readonly responseTokenReserve?: number;

  constructor(config: AgentConfig) {
    this.model = config.model;
    this.memory = config.memory;
    this.maxIterations = config.maxIterations ?? 100;
    this.maxTokens = config.maxTokens;
    this.memoryTopK = config.memoryTopK ?? 5;
    this.contextTokenLimit = config.contextTokenLimit;
    this.responseTokenReserve = config.responseTokenReserve;
  }

  async runTurn(input: RunTurnInput): Promise<string> {
    logger.debug("Turn start");

    const recall = await this.memory.recall({
      scope: input.scope,
      query: input.text,
      topK: this.memoryTopK,
      systemPrompt: SYSTEM_PROMPT,
      ...(this.contextTokenLimit ? { contextTokenLimit: this.contextTokenLimit } : {}),
      ...(this.responseTokenReserve ? { responseTokenReserve: this.responseTokenReserve } : {})
    });

    const result = streamText({
      model: this.model,
      system: this.buildSystemPrompt(recall.contextText),
      messages: [
        ...this.toModelMessages(recall.recentMessages),
        {
          role: "user",
          content: [{ type: "text", text: input.text }]
        }
      ],
      tools: {
        exec: execTool,
        memory_recall: createMemoryRecallTool(this.memory, input.scope),
        memory_remember: createMemoryRememberTool(this.memory, input.scope)
      },
      stopWhen: stepCountIs(this.maxIterations),
      maxOutputTokens: this.maxTokens
    });

    let assistantText = "";
    for await (const delta of result.textStream) {
      assistantText += delta;
      if (input.onTextDelta) {
        await input.onTextDelta(delta);
      }
    }

    const response = await result.response;
    if (assistantText.trim() === "") {
      assistantText = this.extractAssistantText(response.messages);
    }

    await this.memory.addConversationMessages({
      scope: input.scope,
      messages: [
        { role: "user", content: input.text },
        { role: "assistant", content: assistantText.trim() || "No response." }
      ],
      source: `conversation:${input.scope.sessionId}`,
      metadata: {
        origin: "agent_loop"
      }
    });

    logger.debug("Turn complete");
    return assistantText;
  }

  private buildSystemPrompt(memoryContext: string): string {
    if (memoryContext.trim() === "") {
      return SYSTEM_PROMPT;
    }

    return `${SYSTEM_PROMPT}\n\nRetrieved memory context:\n${memoryContext}`;
  }

  private toModelMessages(messages: ConversationMessage[]): ModelMessage[] {
    return messages.map((message) => {
      if (message.role === "system") {
        return {
          role: "system" as const,
          content: message.content
        };
      }

      if (message.role === "user") {
        return {
          role: "user" as const,
          content: [{ type: "text" as const, text: message.content }]
        };
      }

      if (message.role === "tool") {
        return {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: message.content }]
        };
      }

      return {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: message.content }]
      };
    });
  }

  private extractAssistantText(messages: ModelMessage[]): string {
    const assistantMessages = messages.filter((message) => message.role === "assistant");
    return assistantMessages
      .map((message) => extractPlainTextFromModelContent(message.content))
      .filter((value) => value.trim() !== "")
      .join("\n")
      .trim();
  }
}
