import { readFile } from "node:fs/promises";
import path from "node:path";
import { createOpenAI } from "@ai-sdk/openai";

import { type Bus } from "@/bus/bus";
import { type ChannelName } from "@/channels/types";
import { Agent, type SubAgentRequest } from "@/core/agent";
import { type Config, getProviderConfig } from "@/utils/config";
import { createLogger } from "@/utils/logger";
import { CONFIG_PATH, pathExists } from "@/utils/utils";

const logger = createLogger("heartbeat");
const HEARTBEAT_FILE_PATH = path.join(CONFIG_PATH, "workspace", "HEARTBEAT.md");

type HeartbeatServiceConfig = {
  bus: Bus;
  config: Config;
};

type SessionTarget = {
  channel: ChannelName;
  chatId: string;
};

export class HeartbeatService {
  private readonly bus: Bus;
  private readonly heartbeatAgent: Agent;
  private readonly reportSession: SessionTarget;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | undefined;
  private runPromise: Promise<void> | undefined;
  private stopped = false;

  constructor(config: HeartbeatServiceConfig) {
    this.bus = config.bus;
    this.reportSession = parseSessionTarget(config.config.heartbeat.reportSession);
    this.intervalMs = Number(config.config.heartbeat.interval) * 1000;

    const provider = getProviderConfig(config.config, config.config.heartbeat.model);
    const openai = createOpenAI({ apiKey: provider.apiKey });
    const model = openai(config.config.heartbeat.model);

    this.heartbeatAgent = new Agent({
      model,
      mode: "heartbeat",
      onSubAgentSpawn: async (request) => {
        await this.spawnSubAgent(request, config.config);
      }
    });
  }

  start() {
    logger.info(`Heartbeat enabled for ${this.reportSession.channel}:${this.reportSession.chatId} every ${this.intervalMs / 1000}s.`);
    this.scheduleNext(0);
  }

  async stop() {
    this.stopped = true;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    if (this.runPromise) {
      await this.runPromise;
    }
  }

  private scheduleNext(delayMs: number) {
    if (this.stopped) {
      return;
    }

    this.timer = setTimeout(() => {
      void this.runCycle();
    }, delayMs);
  }

  private async runCycle() {
    if (this.runPromise) {
      logger.warn("Skipping heartbeat tick because a previous run is still active.");
      this.scheduleNext(this.intervalMs);
      return;
    }

    this.runPromise = this.executeCycle().finally(() => {
      this.runPromise = undefined;
      this.scheduleNext(this.intervalMs);
    });

    await this.runPromise;
  }

  private async executeCycle() {
    try {
      if (!(await pathExists(HEARTBEAT_FILE_PATH))) {
        logger.debug(`Skipping heartbeat; ${HEARTBEAT_FILE_PATH} does not exist.`);
        return;
      }

      const heartbeatMarkdown = await readFile(HEARTBEAT_FILE_PATH, "utf8");
      if (!hasActiveTasks(heartbeatMarkdown)) {
        logger.debug("Skipping heartbeat; no active tasks found.");
        return;
      }

      const contextId = `heartbeat:${Date.now()}`;
      const response = await this.heartbeatAgent.runTurn({
        channel: this.reportSession.channel,
        chatId: this.reportSession.chatId,
        contextId,
        text: [
          "Review the following HEARTBEAT.md content.",
          "Only determine whether there are actionable active tasks.",
          "If there are, immediately delegate the work with the sub_agent tool.",
          "If there are not, respond with exactly 'noop'.",
          "",
          heartbeatMarkdown
        ].join("\n")
      });

      logger.info(`Heartbeat evaluation finished with response: ${response.trim() || "[empty]"}.`);
    } catch (error) {
      logger.error(error instanceof Error ? error.message : error);
    }
  }

  private async spawnSubAgent(request: SubAgentRequest, config: Config) {
    const provider = getProviderConfig(config);
    const openai = createOpenAI({ apiKey: provider.apiKey });
    const model = openai(config.agent.model);
    const subAgent = new Agent({
      model,
      mode: "sub_agent",
      onSubAgentSpawn: async (nestedRequest) => {
        await this.spawnSubAgent(nestedRequest, config);
      }
    });
    const subAgentContextId = `${request.contextId ?? `${request.channel}:${request.chatId}`}:sub-agent:${request.label}:${Date.now()}`;
    const response = await subAgent.runTurn({
      channel: request.channel,
      chatId: request.chatId,
      contextId: subAgentContextId,
      text: request.task
    });

    await this.bus.dispatchSubAgentResult({
      ...request,
      response
    });
  }
}

function parseSessionTarget(value: string): SessionTarget {
  const separatorIndex = value.indexOf(":");
  if (separatorIndex === -1) {
    throw new Error(`Invalid heartbeat.reportSession '${value}'. Expected '<channel>:<chatId>'.`);
  }

  const channel = value.slice(0, separatorIndex).trim();
  const chatId = value.slice(separatorIndex + 1).trim();
  if ((channel !== "http" && channel !== "telegram") || chatId === "") {
    throw new Error(`Invalid heartbeat.reportSession '${value}'. Expected '<channel>:<chatId>'.`);
  }

  return {
    channel,
    chatId
  };
}

function hasActiveTasks(markdown: string): boolean {
  const match = /##\s+Active Tasks\b([\s\S]*?)(?:\n##\s+|\s*$)/i.exec(markdown);
  if (!match) {
    return false;
  }

  const cleaned = match[1]
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));

  return cleaned.length > 0;
}
