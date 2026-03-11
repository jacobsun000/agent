import { Telegraf } from "telegraf";
import { message } from "telegraf/filters";

import { type Channel } from "@/channels/types";
import { type InboundMessage, type OutboundMessageStream } from "@/bus/bus";
import { type TranscriptionService } from "@/services/transcribe";
import { createLogger } from "@/utils/logger";


const TELEGRAM_FLUSH_INTERVAL_MS = 1000;

type TelegramChannelConfig = {
  token: string;
  onMessage: (message: InboundMessage) => Promise<void>;
  transcriptionService: TranscriptionService;
};

const logger = createLogger("channel:telegram");

export class TelegramChannel implements Channel {
  readonly name = "telegram" as const;
  private readonly bot: Telegraf;
  private readonly onMessage: TelegramChannelConfig["onMessage"];
  private readonly transcriptionService: TranscriptionService;

  constructor(config: TelegramChannelConfig) {
    this.bot = new Telegraf(config.token);
    this.onMessage = config.onMessage;
    this.transcriptionService = config.transcriptionService;

    this.bot.on(message("text"), async (ctx) => {
      await this.onMessage({
        channel: this.name,
        chatId: String(ctx.chat.id),
        text: ctx.message.text,
      });
    });

    this.bot.on(message("voice"), async (ctx) => {
      const voiceUrl = await this.bot.telegram.getFileLink(ctx.message.voice.file_id);
      const voiceData = await this.downloadFile(voiceUrl.toString());
      const mimeType = ctx.message.voice.mime_type ?? "audio/ogg";
      const transcript = await this.transcriptionService.transcribe({
        audio: voiceData,
        mimeType,
        filename: `telegram-voice-${ctx.message.voice.file_unique_id}.ogg`
      });

      await this.onMessage({
        channel: this.name,
        chatId: String(ctx.chat.id),
        text: transcript,
        voice: {
          mimeType,
          data: voiceData,
          durationSeconds: ctx.message.voice.duration,
          transcript
        }
      });
    });

    this.bot.on(message("photo"), async (ctx) => {
      const largestPhoto = ctx.message.photo.at(-1);
      if (!largestPhoto) {
        return;
      }

      const photoUrl = await this.bot.telegram.getFileLink(largestPhoto.file_id);
      const imageData = await this.downloadFile(photoUrl.toString());
      const caption = ctx.message.caption?.trim();

      await this.onMessage({
        channel: this.name,
        chatId: String(ctx.chat.id),
        text: caption && caption.length > 0 ? caption : "Please analyze the attached image.",
        images: [{
          mimeType: "image/jpeg",
          data: imageData,
          caption
        }]
      });
    });

    this.bot.on(message("document"), async (ctx) => {
      const mimeType = ctx.message.document.mime_type;
      if (!mimeType?.startsWith("image/")) {
        return;
      }

      const documentUrl = await this.bot.telegram.getFileLink(ctx.message.document.file_id);
      const imageData = await this.downloadFile(documentUrl.toString());
      const caption = ctx.message.caption?.trim();

      await this.onMessage({
        channel: this.name,
        chatId: String(ctx.chat.id),
        text: caption && caption.length > 0 ? caption : "Please analyze the attached image.",
        images: [{
          mimeType,
          data: imageData,
          caption
        }]
      });
    });
  }

  async start() {
    this.bot.launch();
    const user = await this.bot.telegram.getMe();
    logger.info(`Channel Telegram logged in as @${user.username}`);
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

  private async downloadFile(url: string): Promise<Uint8Array> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download Telegram file (${response.status}).`);
    }

    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }
}

function isIgnorableTelegramEditError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.includes("message is not modified");
}
