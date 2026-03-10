import { streamText, stepCountIs, type LanguageModel, type ModelMessage } from "ai";

import { type Context, FileSystemContext } from "@/core/context";
import { execTool } from "@/core/tools/exec";
import { createLogger } from "@/utils/logger";
import { getSystemPrompt } from "@/core/prompt";

const logger = createLogger("agent");

type AgentConfig = {
  model: LanguageModel;
  context?: Context;
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
  private readonly context: Context;
  private readonly maxIterations: number;
  private readonly maxTokens?: number;

  constructor(config: AgentConfig) {
    this.model = config.model;
    this.context = config.context ?? new FileSystemContext();
    this.maxIterations = config.maxIterations ?? 100;
    this.maxTokens = config.maxTokens;
  }

  async runTurn(input: RunTurnInput): Promise<string> {
    logger.debug("Turn start");

    await this.context.add(input.contextId, [{
      role: "user",
      content: [{ type: "text", text: input.text }]
    }]);

    const result = streamText({
      model: this.model,
      system: await getSystemPrompt(),
      messages: this.context.get(input.contextId),
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
    await this.context.add(input.contextId, response.messages as ModelMessage[]);
    logger.debug("Turn complete");
    return assistantText;
  }

  clearContext(contextId?: string) {
    this.context.clear(contextId);
  }
}
