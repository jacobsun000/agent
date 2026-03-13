import { type LanguageModel, stepCountIs, generateText } from "ai";

import { Context } from "@/core/context";
import { createExecTool } from "@/core/tools/exec";

const SUB_AGENT_CLI_TIMEOUT_MS = 60 * 60 * 1_000; // 1 hour
const MAX_CONTEXT_WINDOW = 512000;

type SubAgentConfig = {
  model: LanguageModel;
  systemPrompt: string;
  maxIterations?: number;
}

export class SubAgent {
  private readonly model: LanguageModel;
  private readonly context: Context;
  private readonly maxIterations: number;

  constructor(config: SubAgentConfig) {
    this.model = config.model;
    this.maxIterations = config.maxIterations ?? 100;
    this.context = new Context({ systemPrompt: config.systemPrompt });
  }

  async runTurn(input: string): Promise<string> {
    this.context.add([{
      role: "user",
      content: [{ type: "text", text: input }]
    }]);
    const result = await generateText({
      model: this.model,
      system: this.context.systemPrompt,
      messages: this.context.get(),
      tools: { exec: createExecTool(SUB_AGENT_CLI_TIMEOUT_MS) },
      stopWhen: stepCountIs(this.maxIterations),
    });
    this.context.add(result.response.messages);
    const assistantText = result.text;
    const inputTokens = result.totalUsage.inputTokens || 0;
    if (inputTokens > MAX_CONTEXT_WINDOW) {
      this.context.compact();
    }
    return assistantText;
  }
}

