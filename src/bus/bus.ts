import { Agent } from "@/core/agent";
import { type ChannelName, type Channel } from "@/channels/types";
import { ensurePairingCode, isSessionPaired } from "@/utils/pairing";
import { createLogger } from "@/utils/logger";

export type OutboundMessageStream = {
  write(delta: string): Promise<void>;
  finish(): Promise<void>;
  fail(message: string): Promise<void>;
};

export type InboundMessage = {
  channel: ChannelName;
  chatId: string;
  text: string;
  source?: {
    type: "sub_agent";
    label: string;
    task: string;
  };
};


const logger = createLogger("bus");

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

  async dispatch(message: InboundMessage) {
    const sessionKey = `${message.channel}:${message.chatId}`;
    const previousRun = this.sessionLocks.get(sessionKey) ?? Promise.resolve();
    const currentRun = previousRun
      .catch(() => undefined)
      .then(async () => {
        await this.processMessage(sessionKey, message);
      });

    this.sessionLocks.set(sessionKey, currentRun);

    try {
      await currentRun;
    } finally {
      if (this.sessionLocks.get(sessionKey) === currentRun) {
        this.sessionLocks.delete(sessionKey);
      }
    }
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
        text: message.text,
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
      if (message.source?.type !== "sub_agent") {
        throw error;
      }

      logger.warn(
        `Sub-agent follow-up for ${message.channel}:${message.chatId} has no live reply stream; processing internally only.`
      );
      return undefined;
    }
  }

  private formatMessage(sessionKey: string, text: string): string {
    const keyPart = sessionKey.split('-')[0];
    const textFormatted = text.replaceAll('\n', ' ')
    const textPart = textFormatted.slice(0, 64);
    const textRemainder = textFormatted.length > 64 ? "..." : "";
    return `[${keyPart}]: ${textPart}${textRemainder}`;
  }
}
