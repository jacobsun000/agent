import { Bus } from "@/bus/bus";
import { type ContextStatistics } from "@/core/context";
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
    compaction: {
      model: config.agent.model,
      openAIApiKey: getProviderConfig(config, config.agent.model).apiKey
    }
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
              message: result.message ?? "Session is not paired."
            };
          }

          if (!result.statistics) {
            return {
              message: "No statistics available."
            };
          }

          return {
            message: formatContextStatistics(result.statistics)
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
Compaction model: ${parsedAgentModel.modelId}`);

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

function formatContextStatistics(stats: ContextStatistics): string {
  const successRate = stats.toolCallSuccessRate === null
    ? "n/a"
    : `${(stats.toolCallSuccessRate * 100).toFixed(1)}%`;

  return [
    "Session statistics:",
    `- session: ${stats.sessionId}`,
    `- total messages: ${stats.totalMessages}`,
    `- user messages: ${stats.totalUserMessages}`,
    `- model messages: ${stats.totalModelMessages}`,
    `- system messages: ${stats.totalSystemMessages}`,
    `- tool messages: ${stats.totalToolMessages}`,
    `- total tool calls: ${stats.totalToolCalls}`,
    `- tool successes: ${stats.totalToolCallSuccesses}`,
    `- tool failures: ${stats.totalToolCallFailures}`,
    `- tool success rate: ${successRate}`,
    `- total input tokens: ${stats.totalInputTokens}${stats.inputTokensEstimated ? " (estimated)" : ""}`,
    `- total output tokens: ${stats.totalOutputTokens}${stats.outputTokensEstimated ? " (estimated)" : ""}`
  ].join("\n");
}
