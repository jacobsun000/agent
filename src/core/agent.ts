import { streamText, stepCountIs, type ModelMessage, LanguageModel } from "ai";
import { createConsola } from "consola";
import { execTool } from "@/core/tools/exec";

const logger = createConsola({
  defaults: {
    tag: "agent"
  }
});

const SYSTEM_PROMPT = `
You are a basic personal assistant agent running in a CLI.

You have access to one tool:
- exec: execute a command through bash.

Use the exec tool when you need current local information or when the user asks you to perform an action in the repository. Prefer short, targeted commands. After using tools, summarize what you did and what happened.

When no tool is needed, answer directly. Keep answers concise and practical.
`.trim();

type AgentConfig = {
  model: LanguageModel;
  maxIterations?: number;
  maxTokens?: number;
  // memoryWindow?: number;
}

export class Agent {
  model: LanguageModel;
  maxIterations: number;
  maxTokens?: number;

  constructor(config: AgentConfig) {
    this.model = config.model;
    this.maxIterations = config.maxIterations ?? 100;
    this.maxTokens = config.maxTokens;
  }
  async runLoop(messages: ModelMessage[]): Promise<ModelMessage[]> {
    logger.debug("Loop start")
    const result = streamText({
      model: this.model,
      system: SYSTEM_PROMPT,
      messages,
      tools: {
        exec: execTool
      },
      stopWhen: stepCountIs(this.maxIterations),
      maxOutputTokens: this.maxTokens
    });

    let wroteText = false;
    for await (const delta of result.textStream) {
      if (!wroteText) {
        process.stdout.write("\n");
        wroteText = true;
      }

      process.stdout.write(delta);
    }

    if (wroteText) {
      process.stdout.write("\n");
    }

    logger.debug("Loop complete")
    const response = await result.response;
    return response.messages;
  }
}
