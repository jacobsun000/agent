import { Agent } from "@/core/agent";
import { Statistics } from "@/core/statistics";
import { type ChannelName, type Channel } from "@/channels/types";
import { applyCommand, parseCommand } from "@/services/command";
import { initializeDeferredTelegramReportSessions } from "@/utils/default-session";
import { ensurePairingCode, isSessionPaired } from "@/utils/pairing";
import { createLogger } from "@/utils/logger";

export type OutboundMessageStream = {
  write(delta: string): Promise<void>;
  finish(): Promise<void>;
  fail(message: string): Promise<void>;
};

export type OutboundAttachment = {
  path: string;
  caption: string;
};

export type InboundImage = {
  mimeType: string;
  data: Uint8Array;
  caption?: string;
};

export type InboundVoice = {
  mimeType: string;
  data: Uint8Array;
  durationSeconds?: number;
};

export type InboundFile = {
  mimeType: string;
  originalName: string;
  path: string;
  sizeBytes: number;
  caption?: string;
};

export type InboundMessage = {
  channel: ChannelName;
  chatId: string;
  text: string;
  images?: InboundImage[];
  voice?: InboundVoice;
  files?: InboundFile[];
  source?: {
    type: "sub_agent";
    label: string;
    task: string;
  } | {
    type: "scheduled";
    scheduler: "cron" | "heartbeat";
    jobId: string;
  };
};

const logger = createLogger("bus");
const statistics = Statistics.getInstance();

type BusConfig = {
  agent: Agent;
};

export class Bus {
  private readonly agent: Agent;
  private readonly channels: Channel[] = [];
  private readonly sessionLocks = new Map<string, Promise<void>>();

  constructor(config: BusConfig) {
    this.agent = config.agent;
  }

  registerChannel(channel: Channel) {
    this.channels.push(channel);
  }

  async start() {
    logger.info("Starting channels...");
    await Promise.all(
      this.channels.map(async (channel) => {
        await channel.start();
      })
    );
  }

  async stop() {
    await Promise.all(this.channels.map(async (channel) => channel.stop()));
  }

  async dispatch(message: InboundMessage) {
    const sessionKey = `${message.channel}:${message.chatId}`;
    await this.withSessionLock(sessionKey, async () => {
      const channel = this.channels.find((entry) => entry.name === message.channel);
      if (!channel) {
        logger.error(`Received message for unregistered channel '${message.channel}'.`);
        return;
      }
      if (!await this.checkSessionPaired(channel, sessionKey, message)) {
        return;
      }
      if (await this.tryHandleCommand(channel, message)) {
        return;
      }

      await this.processMessage(channel, sessionKey, message);
    });
  }

  async sendAttachment(message: {
    channel: ChannelName;
    chatId: string;
    attachment: OutboundAttachment;
  }) {
    const channel = this.channels.find((entry) => entry.name === message.channel);
    if (!channel) {
      throw new Error(`Channel '${message.channel}' is not registered.`);
    }

    await channel.sendAttachment(message.chatId, message.attachment);
  }

  async dispatchSubAgentResult(message: {
    channel: ChannelName;
    chatId: string;
    contextId?: string;
    label: string;
    task: string;
    response: string;
  }) {
    const inbound: InboundMessage = {
      channel: message.channel,
      chatId: message.chatId,
      text: [
        `Sub-agent "${message.label}" completed its delegated task.`,
        "Sub-agent response:",
        message.response
      ].join("\n"),
      source: {
        type: "sub_agent",
        label: message.label,
        task: message.task
      }
    };

    await this.dispatch(inbound);
  }

  private async checkSessionPaired(channel: Channel, sessionKey: string, message: InboundMessage): Promise<boolean> {
    let replyStream: OutboundMessageStream | undefined;
    try {

      if (isSessionPaired(sessionKey)) {
        return true;
      }
      replyStream = await this.createReplyStream(channel, message);
      const pairing = ensurePairingCode(sessionKey);
      const pairingMessage = pairing.isNew
        ? `This session is not paired yet.\n\nPairing code: ${pairing.code}\nApprove it locally with: ./agent pair ${pairing.code}`
        : `This session is waiting for approval.\n\nPairing code: ${pairing.code}\nApprove it locally with: ./agent pair ${pairing.code}`;

      if (replyStream) {
        await replyStream.write(pairingMessage);
        await replyStream.finish();
      }
      return false;
    }
    catch (error) {
      logger.error(error);
      if (replyStream) {
        await replyStream.fail(`[ERROR]: ${error}`);
      }
      return false;
    }
  }

  private async processMessage(channel: Channel, sessionKey: string, message: InboundMessage) {
    logger.info(`Inbound Message ${this.formatMessage(sessionKey, message.text)}`);
    let replyStream: OutboundMessageStream | undefined;
    try {
      replyStream = await this.createReplyStream(channel, message);
      if (message.channel === "telegram" && !message.source) {
        const initialized = await initializeDeferredTelegramReportSessions(sessionKey);
        if (initialized) {
          logger.info(`Initialized deferred default Telegram report session to ${sessionKey}.`);
        }
      }

      const response = await this.agent.runTurn({
        channel: message.channel,
        chatId: message.chatId,
        text: this.buildAgentInputText(message),
        voice: message.voice,
        images: message.images,
        onTextDelta: async (delta) => {
          if (replyStream) {
            await replyStream.write(delta);
          }
        }
      });
      logger.info(`Agent Response  ${this.formatMessage(sessionKey, response)}`);
      if (replyStream) {
        await replyStream.finish();
      }
    } catch (error) {
      logger.error(error);
      if (replyStream) {
        await replyStream.fail(`[ERROR]: ${error}`);
      }
    }
  }

  private async tryHandleCommand(channel: Channel, message: InboundMessage): Promise<boolean> {
    if (message.source) {
      return false;
    }

    const command = parseCommand(message.text);
    if (!command) {
      return false;
    }

    try {
      await applyCommand({
        command,
        actions: {
          clearContext: () => {
            this.agent.clear();
          },
          compactContext: async () => {
            await this.agent.compact();
          },
          getStatistics: () => statistics.getCurrentStatistics(),
          dispatchResult: async (text) => {
            await this.sendMessage(channel, message.chatId, text);
          }
        }
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.sendMessage(channel, message.chatId, `Command failed: ${detail}`);
    }

    return true;
  }

  private async createReplyStream(channel: Channel, message: InboundMessage) {
    try {
      return await channel.createReplyStream(message.chatId);
    } catch (error) {
      if (message.source?.type !== "sub_agent" && message.source?.type !== "scheduled") {
        throw error;
      }

      logger.warn(
        `${message.source.type === "sub_agent" ? "Sub-agent follow-up" : "Scheduled message"} for ${message.channel}:${message.chatId} has no live reply stream; processing internally only.`
      );
      return undefined;
    }
  }

  private async sendMessage(channel: Channel, chatId: string, text: string) {
    let replyStream: OutboundMessageStream | undefined;
    try {
      replyStream = await this.createReplyStream(channel, {
        channel: channel.name,
        chatId: chatId,
        text: text
      });

      if (!replyStream) {
        return;
      }

      await replyStream.write(text);
      await replyStream.finish();
    } catch (error) {
      logger.error(error);
      if (replyStream) {
        await replyStream.fail(`[ERROR]: ${error}`);
      }
      return;
    }
  }

  private formatMessage(sessionKey: string, text: string): string {
    const keyPart = sessionKey.split('-')[0];
    const textFormatted = text.replaceAll("\n", " ");
    const textPart = textFormatted.slice(0, 64);
    const textRemainder = textFormatted.length > 64 ? "..." : "";
    return `[${keyPart}]: ${textPart}${textRemainder}`;
  }

  private buildAgentInputText(message: InboundMessage): string {
    const filePaths = message.files?.map((file) => file.path) ?? [];

    if (filePaths.length === 0) {
      return message.text;
    }

    return [
      message.text,
      "",
      "[ATTACHED_FILES]",
      "The user uploaded local file attachments. These files are available in the workspace.",
      ...filePaths.map((filePath) => `- ${filePath}`),
      "[/ATTACHED_FILES]",
    ].join("\n");
  }

  private async withSessionLock<T>(sessionKey: string, work: () => Promise<T>): Promise<T> {
    const previousRun = this.sessionLocks.get(sessionKey) ?? Promise.resolve();
    let release!: () => void;
    const lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queuedRun = previousRun.catch(() => undefined).then(() => lock);
    this.sessionLocks.set(sessionKey, queuedRun);

    await previousRun.catch(() => undefined);
    try {
      return await work();
    } finally {
      release();
      if (this.sessionLocks.get(sessionKey) === queuedRun) {
        this.sessionLocks.delete(sessionKey);
      }
    }
  }
}
