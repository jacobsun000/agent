import { createOpenAI } from "@ai-sdk/openai";

import { loadConfig } from "@/utils/config";
import { Agent } from "@/core/agent";
import { MessageBus } from "@/bus/bus";
import { CliChannel } from "@/channels/cli";
import { TelegramChannel } from "@/channels/telegram";
import { createLogger } from "@/utils/logger";

const logger = createLogger("main");

async function main() {
  const config = loadConfig();
  const openai = createOpenAI({ apiKey: config.provider.apiKey });
  const model = openai(config.provider.model);
  const agent = new Agent({ model });
  const bus = new MessageBus({ agent });

  bus.registerChannel(
    new CliChannel({
      onMessage: async (message) => {
        await bus.dispatch(message);
      }
    })
  );

  if (config.channels.telegram.enabled) {
    bus.registerChannel(
      new TelegramChannel({
        token: config.channels.telegram.token,
        onMessage: async (message) => {
          await bus.dispatch(message);
        }
      })
    );
  }

  logger.info(`Provider: ${config.provider.name}`);
  logger.info(`Model: ${config.provider.model}`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    await bus.stop();
  };

  process.once("SIGINT", () => {
    void shutdown();
  });

  process.once("SIGTERM", () => {
    void shutdown();
  });

  try {
    await bus.start();
  } finally {
    await shutdown();
  }
}

main().catch((error) => {
  logger.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
