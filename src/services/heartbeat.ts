import { readFile } from "node:fs/promises";
import path from "node:path";

import { type Bus } from "@/bus";
import { Agent, type SubAgentRequest } from "@/core/agent";
import { type Config } from "@/utils/config";
import { getConfiguredReportSession, loadConfiguredReportSession } from "@/utils/default-session";
import { createLogger } from "@/utils/logger";
import { createLanguageModel } from "@/utils/model";
import { CONFIG_PATH, pathExists } from "@/utils/utils";
import { HEARTBEAT_PROMPT } from "@/core/prompt";

const logger = createLogger("heartbeat");
const HEARTBEAT_FILE_PATH = path.join(CONFIG_PATH, "workspace", "HEARTBEAT.md");

type HeartbeatServiceConfig = {
  bus: Bus;
  config: Config;
  dispatchSubAgent: (request: SubAgentRequest) => Promise<void>;
};

export class HeartbeatService {
  private readonly bus: Bus;
  private readonly heartbeatAgent: Agent;
  private reportSession;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | undefined;
  private runPromise: Promise<void> | undefined;
  private stopped = false;

  constructor(config: HeartbeatServiceConfig) {
    this.bus = config.bus;
    this.reportSession = getConfiguredReportSession(config.config, "heartbeat");
    this.intervalMs = Number(config.config.heartbeat.interval) * 1000;
    const model = createLanguageModel(config.config, config.config.heartbeat.model);

    this.heartbeatAgent = new Agent({
      systemPrompt: HEARTBEAT_PROMPT,
      model,
      onSubAgentSpawn: config.dispatchSubAgent
    });
  }

  start() {
    if (this.reportSession) {
      logger.info(`Heartbeat enabled for ${this.reportSession.channel}:${this.reportSession.chatId} every ${this.intervalMs / 1000}s.`);
    } else {
      logger.info(`Heartbeat is waiting for an approved Telegram session before sending reports every ${this.intervalMs / 1000}s.`);
    }
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

      const reportSession = this.getReportSession();
      if (!reportSession) {
        logger.debug("Skipping heartbeat; default report session is not initialized yet.");
        return;
      }

      const response = await this.heartbeatAgent.runTurn({
        channel: reportSession.channel,
        chatId: reportSession.chatId,
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

  private getReportSession() {
    if (this.reportSession) {
      return this.reportSession;
    }

    try {
      const resolved = loadConfiguredReportSession("heartbeat");
      if (resolved) {
        this.reportSession = resolved;
        logger.info(`Heartbeat report session initialized to ${resolved.channel}:${resolved.chatId}.`);
      }

      return resolved;
    } catch (error) {
      logger.error(error instanceof Error ? error.message : error);
      return undefined;
    }
  }
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
