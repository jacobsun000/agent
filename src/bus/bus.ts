import { Agent } from "@/core/agent";
import { type ContextStatistics } from "@/core/context";
import { type ChannelName, type Channel, type OutboundAttachment } from "@/channels/types";
import { ensurePairingCode, isSessionPaired } from "@/utils/pairing";
import { createLogger } from "@/utils/logger";

export type OutboundMessageStream = {
  write(delta: string): Promise<void>;
  finish(): Promise<void>;
  fail(message: string): Promise<void>;
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
  transcript: string;
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
    scheduler: "cron";
    jobId: string;
  };
};


const logger = createLogger("bus");

type BusConfig = {
  agent: Agent;
};

export type CompactSessionResult = {
  compacted: boolean;
  message: string;
  beforeMessages: number;
  afterMessages: number;
  compactedResponseId?: string;
};

export type SessionStatisticsResult = {
  paired: boolean;
  message?: string;
  statistics?: ContextStatistics;
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

  async dispatch(message: InboundMessage) {
    const sessionKey = `${message.channel}:${message.chatId}`;
    await this.withSessionLock(sessionKey, async () => {
      await this.processMessage(sessionKey, message);
    });
  }

  async compactSession(input: {
    channel: ChannelName;
    chatId: string;
  }): Promise<CompactSessionResult> {
    const sessionKey = `${input.channel}:${input.chatId}`;
    return this.withSessionLock(sessionKey, async () => {
      if (!isSessionPaired(sessionKey)) {
        const pairing = ensurePairingCode(sessionKey);
        return {
          compacted: false,
          message: `Session is not paired yet. Pairing code: ${pairing.code}`,
          beforeMessages: 0,
          afterMessages: 0
        };
      }

      return this.agent.compactContext({
        contextId: sessionKey,
        channel: input.channel,
        chatId: input.chatId
      });
    });
  }

  async getSessionStatistics(input: {
    channel: ChannelName;
    chatId: string;
  }): Promise<SessionStatisticsResult> {
    const sessionKey = `${input.channel}:${input.chatId}`;
    return this.withSessionLock(sessionKey, async () => {
      if (!isSessionPaired(sessionKey)) {
        const pairing = ensurePairingCode(sessionKey);
        return {
          paired: false,
          message: `Session is not paired yet. Pairing code: ${pairing.code}`
        };
      }

      return {
        paired: true,
        statistics: this.agent.getContextStatistics(sessionKey)
      };
    });
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
        "",
        `Delegated task:`,
        message.task,
        "",
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

  private async processMessage(sessionKey: string, message: InboundMessage) {
    logger.info(`Inbound Message ${this.formatMessage(sessionKey, message.text)}`);
    const channel = this.channels.find((c) => c.name === message.channel)!;

    let replyStream: Awaited<ReturnType<Channel["createReplyStream"]>> | undefined;

    try {
      replyStream = await this.createReplyStream(channel, message);

      if (!isSessionPaired(sessionKey)) {
        const pairing = ensurePairingCode(sessionKey);
        const pairingMessage = pairing.isNew
          ? `This session is not paired yet.\n\nPairing code: ${pairing.code}\nApprove it locally with: ./agent pair ${pairing.code}`
          : `This session is waiting for approval.\n\nPairing code: ${pairing.code}\nApprove it locally with: ./agent pair ${pairing.code}`;

        if (replyStream) {
          await replyStream.write(pairingMessage);
          await replyStream.finish();
        }
        return;
      }

      const response = await this.agent.runTurn({
        channel: message.channel,
        chatId: message.chatId,
        contextId: sessionKey,
        text: this.buildAgentInputText(message),
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
      logger.error(error instanceof Error ? error.message : error);
      if (replyStream) {
        await replyStream.fail("Sorry, something went wrong while generating a reply.");
      }
    }
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
      "[ATTACHED_FILES]",
      "The user uploaded local file attachments. These files are available in the workspace.",
      ...filePaths.map((filePath) => `- ${filePath}`),
      "[/ATTACHED_FILES]",
      "",
      message.text
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
