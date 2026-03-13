import path from "node:path";

import { Telegraf } from "telegraf";
import { Input } from "telegraf";
import { message } from "telegraf/filters";
import telegramifyMarkdown = require("telegramify-markdown");

import { Channel } from "@/channels/types";
import { InboundMessage, OutboundMessageStream, OutboundAttachment } from "@/bus";
import { AttachmentStore } from "@/services/attachment-store";
import { createLogger } from "@/utils/logger";


const TELEGRAM_FLUSH_INTERVAL_MS = 1000;
const TELEGRAM_MAX_MESSAGE_CHARS = 4096;

type TelegramChannelConfig = {
  token: string;
  onMessage: (message: InboundMessage) => Promise<void>;
  onCompactSession?: (input: { chatId: string }) => Promise<string>;
  attachmentStore: AttachmentStore;
};

const logger = createLogger("channel:telegram");

export class TelegramChannel implements Channel {
  readonly name = "telegram" as const;
  private readonly bot: Telegraf;
  private readonly onMessage: TelegramChannelConfig["onMessage"];
  private readonly onCompactSession?: TelegramChannelConfig["onCompactSession"];
  private readonly attachmentStore: AttachmentStore;

  constructor(config: TelegramChannelConfig) {
    this.bot = new Telegraf(config.token);
    this.onMessage = config.onMessage;
    this.onCompactSession = config.onCompactSession;
    this.attachmentStore = config.attachmentStore;
    this.bot.catch(async (error, ctx) => {
      logger.error(`Unhandled Telegram update error: ${error instanceof Error ? error.message : String(error)}`);
      await this.replyWithInboundError(ctx.chat?.id ? String(ctx.chat.id) : undefined, error);
    });

    this.bot.on(message("text"), async (ctx) => {
      try {
        if (isCompactCommand(ctx.message.text)) {
          if (!this.onCompactSession) {
            await ctx.reply("Compaction is not configured.");
            return;
          }

          await ctx.reply("Compacting this session. This can take a moment...");
          try {
            const result = await this.onCompactSession({
              chatId: String(ctx.chat.id)
            });
            await ctx.reply(result);
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            await ctx.reply(`Compaction failed: ${detail}`);
          }
          return;
        }

        await this.onMessage({
          channel: this.name,
          chatId: String(ctx.chat.id),
          text: ctx.message.text,
        });
      } catch (error) {
        await this.replyWithInboundError(String(ctx.chat.id), error);
      }
    });

    this.bot.on(message("voice"), async (ctx) => {
      try {
        const voiceUrl = await this.bot.telegram.getFileLink(ctx.message.voice.file_id);
        const voiceData = await this.downloadFile(voiceUrl.toString());
        const mimeType = ctx.message.voice.mime_type ?? "audio/ogg";
        await this.onMessage({
          channel: this.name,
          chatId: String(ctx.chat.id),
          text: "",
          voice: {
            mimeType,
            data: voiceData,
            durationSeconds: ctx.message.voice.duration,
          }
        });
      } catch (error) {
        await this.replyWithInboundError(String(ctx.chat.id), error);
      }
    });

    this.bot.on(message("photo"), async (ctx) => {
      try {
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
      } catch (error) {
        await this.replyWithInboundError(String(ctx.chat.id), error);
      }
    });

    this.bot.on(message("document"), async (ctx) => {
      try {
        const mimeType = ctx.message.document.mime_type;
        if (mimeType?.startsWith("image/")) {
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
          return;
        }

        const documentUrl = await this.bot.telegram.getFileLink(ctx.message.document.file_id);
        const fileData = await this.downloadFile(documentUrl.toString());
        const caption = ctx.message.caption?.trim();
        const storedFile = await this.attachmentStore.save({
          data: fileData,
          filename: ctx.message.document.file_name
        });

        await this.onMessage({
          channel: this.name,
          chatId: String(ctx.chat.id),
          text: caption && caption.length > 0 ? caption : "Please review the attached file.",
          files: [{
            mimeType: mimeType ?? "application/octet-stream",
            originalName: storedFile.originalName,
            path: storedFile.path,
            sizeBytes: storedFile.sizeBytes,
            caption
          }]
        });
      } catch (error) {
        await this.replyWithInboundError(String(ctx.chat.id), error);
      }
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
      await this.editInitialMessage(chatId, initialMessage.message_id, content);
      lastSentText = content;
    };

    const flushImmediately = async () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }

      editInFlight = editInFlight.then(flushNow);
      await editInFlight;
    };

    const channel = this;

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
          try {
            await flushImmediately();
          } catch (error) {
            logger.error(error instanceof Error ? error.message : error);
          }
          await channel.ensureCompleteFinalDelivery({
            chatId,
            messageId: initialMessage.message_id,
            content
          });
        } finally {
          stopTyping();
        }
      },
      async fail(message) {
        if (content.trim() === "") {
          content = message;
        }

        try {
          try {
            await flushImmediately();
          } catch (error) {
            logger.error(error instanceof Error ? error.message : error);
          }
          await channel.ensureCompleteFinalDelivery({
            chatId,
            messageId: initialMessage.message_id,
            content
          });
        } catch (error) {
          logger.error(error instanceof Error ? error.message : error);
        } finally {
          stopTyping();
        }
      }
    };
  }

  async sendAttachment(chatId: string, attachment: OutboundAttachment): Promise<void> {
    await this.bot.telegram.sendDocument(
      chatId,
      Input.fromLocalFile(attachment.path, attachment.path ?? path.basename(attachment.path)),
      attachment.caption ? { caption: attachment.caption } : undefined
    );
  }

  private async downloadFile(url: string): Promise<Uint8Array> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download Telegram file (${response.status}).`);
    }

    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }

  private async replyWithInboundError(chatId: string | undefined, error: unknown): Promise<void> {
    const detail = error instanceof Error ? error.message : String(error);
    logger.error(detail);
    if (!chatId) {
      return;
    }

    const message = formatTelegramInboundErrorMessage(detail);
    try {
      await this.bot.telegram.sendMessage(chatId, message);
    } catch (sendError) {
      logger.error(sendError instanceof Error ? sendError.message : String(sendError));
    }
  }

  private async ensureCompleteFinalDelivery(input: {
    chatId: string;
    messageId: number;
    content: string;
  }) {
    const chunks = splitIntoTelegramChunks(input.content);
    if (chunks.length === 0) {
      return;
    }

    await this.editInitialMessage(input.chatId, input.messageId, chunks[0]);

    for (const chunk of chunks.slice(1)) {
      await this.sendMessageWithMarkdownFallback(input.chatId, chunk);
    }
  }

  private async editInitialMessage(chatId: string, messageId: number, text: string) {
    const markdown = telegramifyMarkdown(sanitizeTelegramMarkdownInput(text), "remove");

    try {
      await this.bot.telegram.editMessageText(chatId, messageId, undefined, markdown, {
        parse_mode: "MarkdownV2"
      });
    } catch (error) {
      if (isIgnorableTelegramEditError(error)) {
        return;
      }

      if (isTelegramMarkdownParseError(error)) {
        await this.bot.telegram.editMessageText(chatId, messageId, undefined, text);
        return;
      }

      throw error;
    }
  }

  private async sendMessageWithMarkdownFallback(chatId: string, text: string) {
    const markdown = telegramifyMarkdown(sanitizeTelegramMarkdownInput(text), "remove");

    try {
      await this.bot.telegram.sendMessage(chatId, markdown, {
        parse_mode: "MarkdownV2"
      });
    } catch (error) {
      if (!isTelegramMarkdownParseError(error)) {
        throw error;
      }

      await this.bot.telegram.sendMessage(chatId, text);
    }
  }
}

function splitIntoTelegramChunks(value: string): string[] {
  if (value.length <= TELEGRAM_MAX_MESSAGE_CHARS) {
    return [value];
  }

  const chunks: string[] = [];
  let remaining = value;

  while (remaining.length > TELEGRAM_MAX_MESSAGE_CHARS) {
    const window = remaining.slice(0, TELEGRAM_MAX_MESSAGE_CHARS);
    const splitAt = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
    const chunkLength = splitAt > 0 ? splitAt : TELEGRAM_MAX_MESSAGE_CHARS;
    chunks.push(remaining.slice(0, chunkLength));
    remaining = remaining.slice(chunkLength).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

function sanitizeTelegramMarkdownInput(value: string): string {
  return value.replaceAll(/<(think|reasoning|analysis)>[\s\S]*?<\/\1>/gi, "").trim();
}

function formatTelegramInboundErrorMessage(detail: string): string {
  const normalized = detail.toLowerCase();
  if (normalized.includes("timed out") || normalized.includes("timeout")) {
    return `Request timed out while processing your message: ${detail}`;
  }

  return `Failed to process your message: ${detail}`;
}

function isIgnorableTelegramEditError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.includes("message is not modified");
}

function isTelegramMarkdownParseError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.includes("can't parse entities");
}

function isCompactCommand(text: string): boolean {
  const command = text.trim().split(/\s+/)[0]?.toLowerCase();
  return command === "/compact" || command?.startsWith("/compact@") === true;
}
