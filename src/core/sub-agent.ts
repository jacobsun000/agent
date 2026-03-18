import { type LanguageModel, stepCountIs, generateText } from "ai";
import { TavilyClient } from "@tavily/core";

import { Context } from "@/core/context";
import { createExecTool } from "@/core/tools/exec";
import { createWebFetchTool } from "@/core/tools/web-fetch";
import { createWebSearchTool } from "@/core/tools/web-search";
import { Statistics } from "@/core/statistics";

const SUB_AGENT_CLI_TIMEOUT_MS = 60 * 60 * 1_000; // 1 hour
const MAX_CONTEXT_WINDOW = 512000;
const statistics = Statistics.getInstance();

type SubAgentConfig = {
  model: LanguageModel;
  systemPrompt: string;
  tavily: TavilyClient;
  maxIterations?: number;
}

export class SubAgent {
  private readonly model: LanguageModel;
  private readonly context: Context;
  private readonly tavily: TavilyClient;
  private readonly maxIterations: number;

  constructor(config: SubAgentConfig) {
    this.model = config.model;
    this.maxIterations = config.maxIterations ?? 100;
    this.tavily = config.tavily;
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
      tools: {
        exec: createExecTool(SUB_AGENT_CLI_TIMEOUT_MS),
        web_search: createWebSearchTool({ tavily: this.tavily }),
        web_fetch: createWebFetchTool({ tavily: this.tavily })
      },
      stopWhen: stepCountIs(this.maxIterations),
    });
    statistics.addLanguageModelUsage(result.totalUsage);
    this.context.add(result.response.messages);
    const assistantText = result.text;
    const inputTokens = result.totalUsage.inputTokens || 0;
    if (inputTokens > MAX_CONTEXT_WINDOW) {
      this.context.compact();
    }
    return assistantText;
  }
}
