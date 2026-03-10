import { createOpenAI } from "@ai-sdk/openai";

import { Bus } from "@/bus/bus";
import { HttpChannel } from "@/channels/http";
import { TelegramChannel } from "@/channels/telegram";
import { Agent } from "@/core/agent";
import { createLogger } from "@/utils/logger";
import { loadConfig } from "@/utils/config";

const logger = createLogger("gateway");

type GatewayHandle = {
  stop(): Promise<void>;
  waitUntilStopped(): Promise<void>;
};

export async function startGateway(): Promise<GatewayHandle> {
  const config = loadConfig();
  const openai = createOpenAI({ apiKey: config.provider.apiKey });
  const model = openai(config.provider.model);
  const agent = new Agent({
    model,
  });
  const bus = new Bus({ agent });

  if (config.channels.http.enabled) {
    bus.registerChannel(
      new HttpChannel({
        ...config.channels.http,
        onMessage: async (message) => {
          await bus.dispatch(message);
        }
      })
    );
  }

  if (config.channels.telegram.enabled) {
    bus.registerChannel(
      new TelegramChannel({
        ...config.channels.telegram,
        onMessage: async (message) => {
          await bus.dispatch(message);
        }
      })
    );
  }

  await bus.start();

  logger.box(`Agent Gateway
Provider: ${config.provider.name}
Model: ${config.provider.model}`);

  let stopPromise: Promise<void> | undefined;
  let resolveStopped!: () => void;
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });

  const stop = async () => {
    if (stopPromise) {
      return stopPromise;
    }

    stopPromise = (async () => {
      try {
        await bus.stop();
      } finally {
        resolveStopped();
      }
    })();

    return stopPromise;
  };

  const waitUntilStopped = async () => {
    await stopped;
  };

  return {
    stop,
    waitUntilStopped
  };
}
