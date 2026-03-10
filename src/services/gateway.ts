import { createOpenAI } from "@ai-sdk/openai";

import { Bus } from "@/bus/bus";
import { HttpChannel } from "@/channels/http";
import { TelegramChannel } from "@/channels/telegram";
import { Agent } from "@/core/agent";
import { MemoryService } from "@/memory";
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
  const memory = new MemoryService({
    apiKey: config.provider.apiKey,
    ...(config.memory?.dbPath ? { dbPath: config.memory.dbPath } : {}),
    ...(config.memory?.chatModel ? { chatModel: config.memory.chatModel } : {}),
    ...(config.memory?.embeddingModel ? { embeddingModel: config.memory.embeddingModel } : {}),
    ...(config.memory?.recentMessageLimit
      ? { recentMessageLimit: config.memory.recentMessageLimit }
      : {}),
    ...(config.memory?.consolidationBufferMessages
      ? { consolidationBufferMessages: config.memory.consolidationBufferMessages }
      : {}),
    ...(config.memory?.contextTokenLimit
      ? { contextTokenLimit: config.memory.contextTokenLimit }
      : {}),
    ...(config.memory?.responseTokenReserve
      ? { responseTokenReserve: config.memory.responseTokenReserve }
      : {})
  });
  const agent = new Agent({
    model,
    memory,
    ...(config.memory?.recallTopK ? { memoryTopK: config.memory.recallTopK } : {}),
    ...(config.memory?.contextTokenLimit
      ? { contextTokenLimit: config.memory.contextTokenLimit }
      : {}),
    ...(config.memory?.responseTokenReserve
      ? { responseTokenReserve: config.memory.responseTokenReserve }
      : {})
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
        memory.close();
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
