import { streamText, stepCountIs, type LanguageModel, type ModelMessage } from "ai";

import { type ChannelName } from "@/channels/types";
import { type Context, type ContextStatistics, FileSystemContext } from "@/core/context";
import { createCronTool, type CronToolInput } from "@/core/tools/cron";
import { type InboundImage } from "@/bus/bus";
import { createExecTool } from "@/core/tools/exec";
import { createSendFileTool } from "@/core/tools/send-file";
import { createSubAgentTool } from "@/core/tools/sub-agent";
import { createLogger } from "@/utils/logger";
import { getSystemPrompt } from "@/core/prompt";
import { parseModel } from "@/utils/model";

const logger = createLogger("agent");
const COMPACTION_PREP_PROMPT = [
  "System maintenance notice: conversation memory compaction is about to run for this session.",
  "Before compaction proceeds, review this chat context and write any essential durable memory to:",
  "- <workspace>/memory/MEMORY.md",
  "- <workspace>/memory/notes/<topic>.md",
  "Keep MEMORY.md concise and move details to notes."
].join("\n");

export type AgentMode = "main" | "sub_agent" | "heartbeat";

export type SubAgentRequest = {
  channel: ChannelName;
  chatId: string;
  contextId?: string;
  label: string;
  task: string;
};

type AgentConfig = {
  model: LanguageModel;
  context?: Context;
  maxIterations?: number;
  maxTokens?: number;
  memoryWindow?: number;
  recentMessageLimit?: number;
  mode?: AgentMode;
  onSubAgentSpawn?: (request: SubAgentRequest) => Promise<void>;
  onCronAction?: (input: CronToolInput) => Promise<unknown>;
  onSendFile?: (input: {
    channel: ChannelName;
    chatId: string;
    path: string;
    filename?: string;
    caption?: string;
  }) => Promise<void>;
  compaction?: {
    model: string;
    openAIApiKey: string;
  };
};

type RunTurnInput = {
  channel?: ChannelName;
  chatId?: string;
  contextId?: string;
  text: string;
  images?: InboundImage[];
  onTextDelta?: (delta: string) => void | Promise<void>;
  skipAutoCompact?: boolean;
};

export class Agent {
  private readonly model: LanguageModel;
  private readonly context: Context;
  private readonly maxIterations: number;
  private readonly maxTokens?: number;
  private readonly memoryWindow?: number;
  private readonly mode: AgentMode;
  private readonly onSubAgentSpawn?: AgentConfig["onSubAgentSpawn"];
  private readonly onCronAction?: AgentConfig["onCronAction"];
  private readonly onSendFile?: AgentConfig["onSendFile"];
  private readonly compaction?: AgentConfig["compaction"];

  constructor(config: AgentConfig) {
    this.model = config.model;
    this.context = config.context ?? new FileSystemContext();
    this.maxIterations = config.maxIterations ?? 100;
    this.maxTokens = config.maxTokens;
    this.memoryWindow = config.memoryWindow;
    this.mode = config.mode ?? "main";
    this.onSubAgentSpawn = config.onSubAgentSpawn;
    this.onCronAction = config.onCronAction;
    this.onSendFile = config.onSendFile;
    this.compaction = config.compaction;
  }

  async runTurn(input: RunTurnInput): Promise<string> {
    logger.debug("Turn start");

    await this.context.add(input.contextId, [{
      role: "user",
      content: [
        { type: "text", text: input.text },
        ...(input.images ?? []).map((image) => ({
          type: "image" as const,
          mediaType: image.mimeType,
          image: image.data
        }))
      ]
    }]);

    const result = streamText({
      model: this.model,
      system: await getSystemPrompt(this.mode),
      messages: this.context.get(input.contextId),
      tools: this.getTools(input),
      stopWhen: stepCountIs(this.maxIterations),
      maxOutputTokens: this.maxTokens
    });

    let assistantText = "";
    for await (const delta of result.textStream) {
      assistantText += delta;
      if (input.onTextDelta) {
        await input.onTextDelta(delta);
      }
    }

    const [response, totalUsage] = await Promise.all([result.response, result.totalUsage]);
    const lastInputTokens = totalUsage.inputTokens;
    const lastOutputTokens = totalUsage.outputTokens;
    await this.context.add(input.contextId, response.messages as ModelMessage[]);
    await this.context.recordTurnUsage(input.contextId, {
      inputTokens: lastInputTokens,
      outputTokens: lastOutputTokens,
      estimatedOutputTokens: estimateTextTokens(assistantText)
    });
    await this.maybeAutoCompact(input, lastInputTokens).catch((error) => {
      logger.warn(
        `Auto-compaction failed for context '${input.contextId ?? "default"}': ${error instanceof Error ? error.message : String(error)}`
      );
    });
    logger.debug("Turn complete");
    return assistantText;
  }

  clearContext(contextId?: string) {
    this.context.clear(contextId);
  }

  getContextStatistics(contextId?: string): ContextStatistics {
    return this.context.statistics(contextId);
  }

  async compactContext(input: {
    contextId?: string;
    channel?: ChannelName;
    chatId?: string;
  }): Promise<{
    compacted: boolean;
    message: string;
    beforeMessages: number;
    afterMessages: number;
    compactedResponseId?: string;
  }> {
    if (!this.compaction) {
      throw new Error("Compaction is not configured for this agent.");
    }

    const model = parseModel(this.compaction.model);
    if (model.provider !== "openai") {
      throw new Error("Compaction currently supports only OpenAI models.");
    }

    return this.context.compact(input.contextId, {
      model: model.modelId,
      openAIApiKey: this.compaction.openAIApiKey,
      notify: async () => {
        await this.runTurn({
          channel: input.channel,
          chatId: input.chatId,
          contextId: input.contextId,
          text: COMPACTION_PREP_PROMPT,
          skipAutoCompact: true
        });
      }
    });
  }

  private async maybeAutoCompact(input: RunTurnInput, lastInputTokens?: number): Promise<void> {
    if (input.skipAutoCompact || this.mode !== "main") {
      return;
    }

    if (typeof this.memoryWindow !== "number" || this.memoryWindow <= 0) {
      return;
    }

    if (typeof lastInputTokens !== "number" || !Number.isFinite(lastInputTokens)) {
      return;
    }

    const normalizedInputTokens = Math.max(0, Math.floor(lastInputTokens));
    if (normalizedInputTokens <= this.memoryWindow) {
      return;
    }

    logger.info(
      `Auto-compacting context '${input.contextId ?? "default"}' (${normalizedInputTokens} input tokens > memoryWindow ${this.memoryWindow}).`
    );
    await this.compactContext({
      contextId: input.contextId,
      channel: input.channel,
      chatId: input.chatId
    });
  }

  private getTools(input: RunTurnInput) {
    return {
      exec: createExecTool(this.mode),
      cron: createCronTool({
        enabled: this.mode === "main" && !!this.onCronAction,
        onAction: async (cronInput) => {
          if (!this.onCronAction) {
            throw new Error("Cron actions are not configured.");
          }

          return this.onCronAction(cronInput);
        }
      }),
      sub_agent: createSubAgentTool({
        enabled: !!this.onSubAgentSpawn,
        onSpawn: async ({ label, task }) => {
          if (!this.onSubAgentSpawn) {
            throw new Error("Sub-agent spawning is not configured.");
          }

          if (!input.channel || !input.chatId) {
            throw new Error("Sub-agent tasks require a channel and chat ID.");
          }

          await this.onSubAgentSpawn({
            channel: input.channel,
            chatId: input.chatId,
            contextId: input.contextId,
            label,
            task
          });
        }
      }),
      send_file: createSendFileTool({
        enabled: !!this.onSendFile,
        onSend: async ({ path, filename, caption }) => {
          if (!this.onSendFile) {
            throw new Error("File sending is not configured.");
          }

          if (!input.channel || !input.chatId) {
            throw new Error("Sending files requires a channel and chat ID.");
          }

          await this.onSendFile({
            channel: input.channel,
            chatId: input.chatId,
            path,
            filename,
            caption
          });
        }
      })
    };
  }
}

function estimateTextTokens(text: string): number {
  if (text.trim() === "") {
    return 0;
  }

  return Math.ceil(text.length / 4);
}
