import { streamText, stepCountIs, type LanguageModel, type ModelMessage } from "ai";

import { Context } from "@/core/context";
import { execTool } from "@/core/tools/exec";
import { createLogger } from "@/utils/logger";
import { getSystemPrompt } from "@/core/prompt";

const logger = createLogger("agent");

type AgentConfig = {
  model: LanguageModel;
  maxIterations?: number;
  maxTokens?: number;
  recentMessageLimit?: number;
};

type RunTurnInput = {
  contextId?: string;
  text: string;
  onTextDelta?: (delta: string) => void | Promise<void>;
};

export class Agent {
  private readonly model: LanguageModel;
  private readonly contexts = new Map<string, Context>();
  private readonly maxIterations: number;
  private readonly maxTokens?: number;

  constructor(config: AgentConfig) {
    this.model = config.model;
    this.maxIterations = config.maxIterations ?? 100;
    this.maxTokens = config.maxTokens;
  }

  async runTurn(input: RunTurnInput): Promise<string> {
    logger.debug("Turn start");
    const context = this.getContext(input.contextId);

    await context.add([{
      role: "user",
      content: [{ type: "text", text: input.text }]
    }]);

    const result = streamText({
      model: this.model,
      system: await getSystemPrompt(),
      messages: context.get(),
      tools: {
        exec: execTool,
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
    await context.add(response.messages as ModelMessage[]);
    logger.debug("Turn complete");
    return assistantText;
  }

  clearContext(contextId?: string) {
    const key = contextId ?? "default";
    const context = this.contexts.get(key);

    if (!context) {
      return;
    }

    context.clear();
  }

  private getContext(contextId?: string): Context {
    const key = contextId ?? "default";
    let context = this.contexts.get(key);

    if (!context) {
      context = new Context();
      this.contexts.set(key, context);
    }

    return context;
  }
}
