import { Bus } from "@/bus/bus";
import { HttpChannel } from "@/channels/http";
import { TelegramChannel } from "@/channels/telegram";
import { Agent } from "@/core/agent";
import { createAttachmentStore } from "@/services/attachment-store";
import { CronService } from "@/services/cron";
import { HeartbeatService } from "@/services/heartbeat";
import { createSubAgentDispatcher } from "@/services/sub-agent-dispatcher";
import { createTranscriptionService } from "@/services/transcribe";
import { createLogger } from "@/utils/logger";
import { getProviderConfig, loadConfig } from "@/utils/config";
import { createLanguageModel, parseModel } from "@/utils/model";
import { formatContextStatisticsMarkdown, formatSessionStatsMarkdownMessage } from "@/utils/utils";

const logger = createLogger("gateway");

type GatewayHandle = {
  stop(): Promise<void>;
  waitUntilStopped(): Promise<void>;
};

export async function startGateway(): Promise<GatewayHandle> {
  const config = loadConfig();
  const provider = getProviderConfig(config);
  const parsedAgentModel = parseModel(config.agent.model);
  const model = createLanguageModel(config, config.agent.model);
  const attachmentStore = createAttachmentStore();
  const transcriptionService = createTranscriptionService(config);
  const compactionProvider = getProviderConfig(config, config.agent.model);
  const compactionConfig = parsedAgentModel.provider === "openai"
    ? {
        model: config.agent.model,
        openAIApiKey: compactionProvider.apiKey
      }
    : undefined;
  let bus!: Bus;
  let cron!: CronService;
  let spawnSubAgent!: ReturnType<typeof createSubAgentDispatcher>;
  const agent = new Agent({
    model,
    memoryWindow: config.agent.memoryWindow,
    onSubAgentSpawn: async (request) => spawnSubAgent(request),
    onCronAction: async (input) => cron.handleToolAction(input),
    onSendFile: async ({ channel, chatId, path, filename, caption }) => {
      await bus.sendAttachment({
        channel,
        chatId,
        attachment: {
          path,
          filename,
          caption
        }
      });
    },
    compaction: compactionConfig
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
        transcriptionService,
        onCompactSession: async ({ chatId }) =>
          bus.compactSession({
            channel: "telegram",
            chatId
          }),
        onStatsSession: async ({ chatId }) => {
          const result = await bus.getSessionStatistics({
            channel: "telegram",
            chatId
          });

          if (!result.paired) {
            return {
              message: formatSessionStatsMarkdownMessage(result.message ?? "Session is not paired.")
            };
          }

          if (!result.statistics) {
            return {
              message: formatSessionStatsMarkdownMessage("No statistics available.")
            };
          }

          return {
            message: formatContextStatisticsMarkdown(result.statistics)
          };
        },
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
Model: ${config.agent.model}
Compaction model: ${compactionConfig ? parsedAgentModel.modelId : "disabled (OpenAI-only)"}`);

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
