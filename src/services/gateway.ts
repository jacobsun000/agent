import { tavily } from "@tavily/core";
import { Bus } from "@/bus";
import { HttpChannel } from "@/channels/http";
import { TelegramChannel } from "@/channels/telegram";
import { Agent } from "@/core/agent";
import { createAttachmentStore } from "@/services/attachment-store";
import { CronService } from "@/services/cron";
import { HeartbeatService } from "@/services/heartbeat";
import { createSubAgentDispatcher } from "@/services/sub-agent-dispatcher";
import { createLogger } from "@/utils/logger";
import { getProviderConfig, loadConfig } from "@/utils/config";
import { createLanguageModel, getTranscribeModel } from "@/utils/model";
import { getSystemPrompt } from "@/core/prompt";

const logger = createLogger("gateway");

type GatewayHandle = {
  stop(): Promise<void>;
  waitUntilStopped(): Promise<void>;
};

export async function startGateway(): Promise<GatewayHandle> {
  const config = loadConfig();
  const tavilyClient = tavily({ apiKey: config.web.tavilyApiKey });
  const provider = getProviderConfig(config);
  const model = createLanguageModel(config, config.agent.model);
  const attachmentStore = createAttachmentStore();
  const mainSystemPrompt = await getSystemPrompt('main');
  let bus!: Bus;
  let cron!: CronService;
  let spawnSubAgent!: ReturnType<typeof createSubAgentDispatcher>;
  const agent = new Agent({
    systemPrompt: mainSystemPrompt,
    transcribeModel: getTranscribeModel(),
    model,
    tavily: tavilyClient,
    enableWebTools: true,
    onSubAgentSpawn: async (request) => spawnSubAgent(request),
    onCronAction: async (input) => cron.handleToolAction(input),
    onSendFile: async ({ channel, chatId, path, caption }) => {
      await bus.sendAttachment({
        channel,
        chatId,
        attachment: {
          path,
          caption
        }
      });
    },
  });
  bus = new Bus({ agent, enableStream: config.agent.enableStream });
  spawnSubAgent = createSubAgentDispatcher({ bus, config, tavily: tavilyClient });
  cron = new CronService({ bus, config });
  const heartbeat = new HeartbeatService({
    bus,
    config,
    dispatchSubAgent: spawnSubAgent
  });

  if (config.channels.http.enabled) {
    bus.registerChannel(
      new HttpChannel({
        ...config.channels.http,
        attachmentStore,
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
        attachmentStore,
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
