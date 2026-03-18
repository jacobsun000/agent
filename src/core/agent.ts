import { streamText, stepCountIs, type LanguageModel, type ModelMessage, experimental_transcribe, TranscriptionModel } from "ai";
import { TavilyClient } from "@tavily/core";

import { Context } from "@/core/context";
import { InboundVoice, type InboundImage } from "@/bus";
import { type ChannelName } from "@/channels/types";
import { createLogger } from "@/utils/logger";

import { createExecTool } from "@/core/tools/exec";
import { createSendFileTool } from "@/core/tools/send-file";
import { createSubAgentTool } from "@/core/tools/sub-agent";
import { createCronTool, type CronToolInput } from "@/core/tools/cron";
import { createWebSearchTool } from "@/core/tools/web-search";
import { createWebFetchTool } from "@/core/tools/web-fetch";
import { Statistics } from "@/core/statistics";


const AGENT_CLI_TIMEOUT_MS = 2 * 1_000; // 2 minutes
const MAX_CONTEXT_WINDOW = 512000;

const logger = createLogger("agent");
const statistics = Statistics.getInstance();

export type AgentMode = "main" | "sub_agent" | "heartbeat";

export type SubAgentRequest = {
  channel: ChannelName;
  chatId: string;
  contextId?: string;
  label: string;
  task: string;
};

type AgentConfig = {
  systemPrompt: string;
  model: LanguageModel;
  transcribeModel?: TranscriptionModel;
  maxIterations?: number;
  tavily?: TavilyClient;
  enableWebTools?: boolean;
  onSubAgentSpawn?: (request: SubAgentRequest) => Promise<void>;
  onCronAction?: (input: CronToolInput) => Promise<unknown>;
  onSendFile?: (input: {
    channel: ChannelName;
    chatId: string;
    path: string;
    caption: string;
  }) => Promise<void>;
};

type RunTurnInput = {
  channel?: ChannelName;
  chatId?: string;
  text: string;
  voice?: InboundVoice;
  images?: InboundImage[];
  onTextDelta?: (delta: string) => void | Promise<void>;
};

export class Agent {
  private readonly model: LanguageModel;
  private readonly transcribeModel?: TranscriptionModel;
  private readonly context: Context;
  private readonly maxIterations: number;
  private readonly tavily?: TavilyClient;
  private readonly enableWebTools: boolean;
  private readonly onSubAgentSpawn?: AgentConfig["onSubAgentSpawn"];
  private readonly onCronAction?: AgentConfig["onCronAction"];
  private readonly onSendFile?: AgentConfig["onSendFile"];

  constructor(config: AgentConfig) {
    this.model = config.model;
    this.transcribeModel = config.transcribeModel;
    this.context = new Context({ systemPrompt: config.systemPrompt });
    this.maxIterations = config.maxIterations ?? 100;
    this.tavily = config.tavily;
    this.enableWebTools = config.enableWebTools ?? false;
    this.onSubAgentSpawn = config.onSubAgentSpawn;
    this.onCronAction = config.onCronAction;
    this.onSendFile = config.onSendFile;
  }

  async runTurn(input: RunTurnInput): Promise<string> {
    logger.debug("Turn start");

    const transcription = await this.getTranscription(input.voice);

    await this.context.add([{
      role: "user",
      content: [
        { type: "text", text: `${transcription}${input.text}` },
        ...(input.images ?? []).map((image) => ({
          type: "image" as const,
          mediaType: image.mimeType,
          image: image.data
        }))
      ]
    }]);

    const result = streamText({
      model: this.model,
      system: this.context.systemPrompt,
      messages: this.context.get(),
      tools: this.getTools(input),
      stopWhen: stepCountIs(this.maxIterations),
    });

    let assistantText = "";
    for await (const delta of result.textStream) {
      assistantText += delta;
      if (input.onTextDelta) {
        await input.onTextDelta(delta);
      }
    }

    const [response, totalUsage] = await Promise.all([result.response, result.totalUsage]);
    statistics.addLanguageModelUsage(totalUsage);
    const inputTokens = totalUsage.inputTokens || 0;
    await this.context.add(response.messages as ModelMessage[]);
    if (inputTokens > MAX_CONTEXT_WINDOW) {
      await this.compact();
    }
    logger.debug("Turn complete");
    return assistantText;
  }

  clear() {
    this.context.clear();
  }

  async compact() {
    await this.context.compact();
  }

  private getTools(input: RunTurnInput) {
    const tools = {
      exec: createExecTool(AGENT_CLI_TIMEOUT_MS),
      cron: createCronTool({
        onAction: async (cronInput) => {
          if (!this.onCronAction) {
            throw new Error("Cron actions are not configured.");
          }

          return this.onCronAction(cronInput);
        }
      }),
      sub_agent: createSubAgentTool({
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
            label,
            task
          });
        }
      }),
      send_file: createSendFileTool({
        onSend: async ({ path, caption }) => {
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
            caption
          });
        }
      })
    };

    if (this.enableWebTools) {
      if (!this.tavily) {
        throw new Error("Web tools are enabled but Tavily client is not configured.");
      }
      return {
        ...tools,
        web_search: createWebSearchTool({ tavily: this.tavily }),
        web_fetch: createWebFetchTool({ tavily: this.tavily })
      };
    }

    return tools;
  }

  private async getTranscription(voice?: InboundVoice): Promise<string> {
    if (!voice) {
      return "";
    }
    if (!this.transcribeModel) {
      return "[ERROR: No transcription model configured] ";
    }
    const result = await experimental_transcribe({
      model: this.transcribeModel,
      audio: voice.data,
    })
    return `${result.text} `;
  }
}
