import { createOpenAI } from "@ai-sdk/openai";

import { Bus } from "@/bus/bus";
import { HttpChannel } from "@/channels/http";
import { TelegramChannel } from "@/channels/telegram";
import { Agent } from "@/core/agent";
import { CronService } from "@/services/cron";
import { HeartbeatService } from "@/services/heartbeat";
import { createSubAgentDispatcher } from "@/services/sub-agent-dispatcher";
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
  let cron!: CronService;
  let spawnSubAgent!: ReturnType<typeof createSubAgentDispatcher>;
  const agent = new Agent({
    model,
    onSubAgentSpawn: async (request) => spawnSubAgent(request),
    onCronAction: async (input) => cron.handleToolAction(input)
  });
  bus = new Bus({ agent });
  spawnSubAgent = createSubAgentDispatcher({ bus, config });
  cron = new CronService({
    bus,
    config
  });
  const heartbeat = new HeartbeatService({
    bus,
    config,
    dispatchSubAgent: spawnSubAgent
  });

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
  cron.start();
  heartbeat.start();

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
        await cron.stop();
        await heartbeat.stop();
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
