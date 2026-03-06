import { type ModelMessage } from "ai";
import { createConsola } from "consola";
import { createOpenAI } from "@ai-sdk/openai";

import { loadConfig } from "@/utils/config";
import { Agent } from "@/core/agent";

const logger = createConsola({
  defaults: {
    tag: "main"
  }
});

async function main() {
  const config = loadConfig();
  const messages: ModelMessage[] = [];
  const openai = createOpenAI({ apiKey: config.provider.apiKey });
  const model = openai(config.provider.model);
  const agent = new Agent({ model })

  logger.box(
    [
      "CLI agent ready.",
      `Provider: ${config.provider.name}`,
      `Model: ${config.provider.model}`,
      "Type a request, or use `exit` to quit."
    ].join("\n")
  );

  while (true) {
    const userInput = await logger.prompt("", { placeholder: "Ask me to do something..." });

    if (userInput === "exit") {
      break;
    }

    messages.push({
      role: "user",
      content: [{ type: "text", text: userInput as string }]
    });

    const response = await agent.runLoop(messages);
    messages.push(...response);
  }
}

main().catch((error) => {
  logger.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
