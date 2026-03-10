import { Agent } from "@/core/agent";
import { type ChannelName, type Channel } from "@/channels/types";
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

  private async processMessage(sessionKey: string, message: InboundMessage) {
    const channel = this.channels.find((c) => c.name === message.channel)!;

    let replyStream: Awaited<ReturnType<Channel["createReplyStream"]>> | undefined;

    try {
      replyStream = await channel.createReplyStream(message.chatId);

      await this.agent.runTurn({
        contextId: sessionKey,
        text: message.text,
        onTextDelta: async (delta) => {
          if (replyStream) {
            await replyStream.write(delta);
          }
        }
      });
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
}
