import { Telegraf } from "telegraf";

import { type Channel } from "@/channels/types";
import { type InboundMessage, type OutboundMessageStream } from "@/bus/bus";
import { createLogger } from "@/utils/logger";
import { message } from "telegraf/filters";


const TELEGRAM_FLUSH_INTERVAL_MS = 500;

type TelegramChannelConfig = {
  token: string;
  onMessage: (message: InboundMessage) => Promise<void>;
};

const logger = createLogger("channel:telegram")

export class TelegramChannel implements Channel {
  readonly name = "telegram" as const;
  private readonly bot: Telegraf;
  private readonly onMessage: TelegramChannelConfig["onMessage"];

  constructor(config: TelegramChannelConfig) {
    this.bot = new Telegraf(config.token);
    this.onMessage = config.onMessage;

    this.bot.on(message("text"), async (ctx) => {
      await this.onMessage({
        channel: this.name,
        chatId: String(ctx.chat.id),
        text: ctx.message.text,
      });
    });
  }

  async start() {
    await this.bot.launch();
  }

  async stop() {
    this.bot.stop();
  }

  async createReplyStream(chatId: string): Promise<OutboundMessageStream> {
    let typingIntervalId: NodeJS.Timeout | undefined;

    const sendTypingAction = async () => {
      try {
        await this.bot.telegram.sendChatAction(chatId, "typing");
      } catch (error) {
        logger.error(error instanceof Error ? error.message : error);
      }
    };

    const stopTyping = () => {
      if (typingIntervalId) {
        clearInterval(typingIntervalId);
        typingIntervalId = undefined;
      }
    };

    await sendTypingAction();
    typingIntervalId = setInterval(() => {
      void sendTypingAction();
    }, TELEGRAM_FLUSH_INTERVAL_MS);

    let initialMessage;
    try {
      initialMessage = await this.bot.telegram.sendMessage(chatId, "...");
    } catch (error) {
      stopTyping();
      throw error;
    }
    let content = "";
    let lastSentText = "...";
    let flushTimer: NodeJS.Timeout | undefined;
    let editInFlight = Promise.resolve();

    const scheduleFlush = () => {
      if (flushTimer) {
        return;
      }

      flushTimer = setTimeout(() => {
        flushTimer = undefined;
        editInFlight = editInFlight.then(flushNow);
      }, TELEGRAM_FLUSH_INTERVAL_MS);
    };

    const flushNow = async () => {
      if (content === lastSentText) {
        return;
      }

      try {
        await this.bot.telegram.editMessageText(chatId, initialMessage.message_id, undefined, content);
        lastSentText = content;
      } catch (error) {
        if (isIgnorableTelegramEditError(error)) {
          return;
        }

        throw error;
      }
    };

    const flushImmediately = async () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }

      editInFlight = editInFlight.then(flushNow);
      await editInFlight;
    };

    return {
      async write(delta) {
        content += delta;
        scheduleFlush();
      },
      async finish() {
        if (content.trim() === "") {
          content = "No response.";
        }

        try {
          await flushImmediately();
        } finally {
          stopTyping();
        }
      },
      async fail(message) {
        if (content.trim() === "") {
          content = message;
        }

        try {
          await flushImmediately();
        } catch (error) {
          logger.error(error instanceof Error ? error.message : error);
        } finally {
          stopTyping();
        }
      }
    };
  }
}

function isIgnorableTelegramEditError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.includes("message is not modified");
}
