import { createOpenAI } from "@ai-sdk/openai";

import { Bus } from "@/bus/bus";
import { HttpChannel } from "@/channels/http";
import { TelegramChannel } from "@/channels/telegram";
import { Agent, type SubAgentRequest } from "@/core/agent";
import { createLogger } from "@/utils/logger";
import { getProviderConfig, loadConfig } from "@/utils/config";

const logger = createLogger("gateway");

type GatewayHandle = {
  stop(): Promise<void>;
  waitUntilStopped(): Promise<void>;
};

export async function startGateway(): Promise<GatewayHandle> {
  const config = loadConfig();
  const provider = getProviderConfig(config);
  const openai = createOpenAI({ apiKey: provider.apiKey });
  const model = openai(config.agent.model);
  let bus!: Bus;
  const spawnSubAgent = async (request: SubAgentRequest) => {
    const subAgent = new Agent({
      model,
      mode: "sub_agent",
      onSubAgentSpawn: spawnSubAgent
    });
    const subAgentContextId = `${request.contextId ?? `${request.channel}:${request.chatId}`}:sub-agent:${request.label}:${Date.now()}`;
    const response = await subAgent.runTurn({
      channel: request.channel,
      chatId: request.chatId,
      contextId: subAgentContextId,
      text: request.task
    });

    await bus.dispatchSubAgentResult({
      ...request,
      response
    });
  };
  const agent = new Agent({
    model,
    onSubAgentSpawn: spawnSubAgent
  });
  bus = new Bus({ agent });

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
Provider: ${provider.name}
Model: ${config.agent.model}`);

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
