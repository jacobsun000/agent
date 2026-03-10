import { streamText, stepCountIs, type LanguageModel, type ModelMessage } from "ai";

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
  text: string;
  onTextDelta?: (delta: string) => void | Promise<void>;
};

export class Agent {
  private readonly model: LanguageModel;
  private readonly messages: ModelMessage[] = [];
  private readonly maxIterations: number;
  private readonly maxTokens?: number;

  constructor(config: AgentConfig) {
    this.model = config.model;
    this.maxIterations = config.maxIterations ?? 100;
    this.maxTokens = config.maxTokens;
  }

  async runTurn(input: RunTurnInput): Promise<string> {
    logger.debug("Turn start");

    this.messages.push({
      role: "user",
      content: [{ type: "text", text: input.text }]
    });

    const result = streamText({
      model: this.model,
      system: await getSystemPrompt(),
      messages: this.messages,
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
    this.messages.push(...response.messages);
    logger.debug("Turn complete");
    return assistantText;
  }
}
