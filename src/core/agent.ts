import { streamText, stepCountIs, type LanguageModel, type ModelMessage } from "ai";

import { type ChannelName } from "@/channels/types";
import { type Context, FileSystemContext } from "@/core/context";
import { createCronTool, type CronToolInput } from "@/core/tools/cron";
import { type InboundImage } from "@/bus/bus";
import { execTool } from "@/core/tools/exec";
import { createSubAgentTool } from "@/core/tools/sub-agent";
import { createLogger } from "@/utils/logger";
import { getSystemPrompt } from "@/core/prompt";

const logger = createLogger("agent");

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
  recentMessageLimit?: number;
  mode?: AgentMode;
  onSubAgentSpawn?: (request: SubAgentRequest) => Promise<void>;
  onCronAction?: (input: CronToolInput) => Promise<unknown>;
};

type RunTurnInput = {
  channel?: ChannelName;
  chatId?: string;
  contextId?: string;
  text: string;
  images?: InboundImage[];
  onTextDelta?: (delta: string) => void | Promise<void>;
};

export class Agent {
  private readonly model: LanguageModel;
  private readonly context: Context;
  private readonly maxIterations: number;
  private readonly maxTokens?: number;
  private readonly mode: AgentMode;
  private readonly onSubAgentSpawn?: AgentConfig["onSubAgentSpawn"];
  private readonly onCronAction?: AgentConfig["onCronAction"];

  constructor(config: AgentConfig) {
    this.model = config.model;
    this.context = config.context ?? new FileSystemContext();
    this.maxIterations = config.maxIterations ?? 100;
    this.maxTokens = config.maxTokens;
    this.mode = config.mode ?? "main";
    this.onSubAgentSpawn = config.onSubAgentSpawn;
    this.onCronAction = config.onCronAction;
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

    const response = await result.response;
    await this.context.add(input.contextId, response.messages as ModelMessage[]);
    logger.debug("Turn complete");
    return assistantText;
  }

  clearContext(contextId?: string) {
    this.context.clear(contextId);
  }

  private getTools(input: RunTurnInput) {
    return {
      exec: execTool,
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
      })
    };
  }
}
