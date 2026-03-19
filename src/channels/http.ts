import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";

import { type InboundMessage, type OutboundMessageStream, type OutboundAttachment } from "@/bus";
import { type Channel } from "@/channels/types";
import { type AttachmentStore } from "@/services/attachment-store";
import { createLogger } from "@/utils/logger";

type HttpChannelConfig = {
  host: string;
  port: number;
  attachmentStore: AttachmentStore;
  onMessage: (message: InboundMessage) => Promise<void>;
};

type HttpRequestBody = {
  chatId?: string;
  text: string;
  images?: Array<{
    mimeType: string;
    dataBase64: string;
    caption?: string;
  }>;
  files?: Array<{
    filename?: string;
    mimeType?: string;
    dataBase64: string;
    caption?: string;
  }>;
};

type HttpChannelEvent =
  | { type: "delta"; delta: string }
  | { type: "finish" }
  | { type: "error"; message: string }
  | { type: "attachment"; filename: string; path: string; caption?: string; dataBase64: string };

type HttpReplyStream = OutboundMessageStream & {
  writeEvent(event: HttpChannelEvent): Promise<void>;
};

const logger = createLogger("channel:http");

export class HttpChannel implements Channel {
  readonly name = "http" as const;
  private readonly host: string;
  private readonly port: number;
  private readonly attachmentStore: AttachmentStore;
  private readonly onMessage: HttpChannelConfig["onMessage"];
  private readonly replyStreams = new Map<string, HttpReplyStream>();
  private server?: Server;

  constructor(config: HttpChannelConfig) {
    this.host = config.host;
    this.port = config.port;
    this.attachmentStore = config.attachmentStore;
    this.onMessage = config.onMessage;
  }

  async start() {
    if (this.server) {
      return;
    }

    const server = createServer(async (request, response) => {
      try {
        await this.handleRequest(request, response);
      } catch (error) {
        logger.error(error instanceof Error ? error.message : error);

        if (!response.headersSent) {
          response.writeHead(500, { "content-type": "application/json" });
        }

        if (!response.writableEnded) {
          response.end(JSON.stringify({ error: "Internal server error." }));
        }
      }
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, this.host, () => {
        server.off("error", reject);
        resolve();
      });
    });

    this.server = server;
    logger.info(`Channel HTTP listening on http://${this.host}:${this.port}`);
  }

  async stop() {
    if (this.server) {
      const server = this.server;
      this.server = undefined;

      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }

    this.replyStreams.clear();
  }

  async reply(chatId: string, message: string): Promise<void> {
    const replyStream = this.replyStreams.get(chatId);

    if (!replyStream) {
      throw new Error(`No HTTP reply stream registered for chat ${chatId}.`);
    }

    await replyStream.write(message);
    await replyStream.finish(message);
  }

  async createReplyStream(chatId: string): Promise<OutboundMessageStream> {
    const replyStream = this.replyStreams.get(chatId);

    if (!replyStream) {
      throw new Error(`No HTTP reply stream registered for chat ${chatId}.`);
    }

    return replyStream;
  }

  async sendAttachment(chatId: string, attachment: OutboundAttachment): Promise<void> {
    const replyStream = this.replyStreams.get(chatId);

    if (!replyStream) {
      throw new Error(`No HTTP reply stream registered for chat ${chatId}.`);
    }

    const fileData = await readFile(attachment.path);
    await replyStream.writeEvent({
      type: "attachment",
      filename: attachment.path ?? path.basename(attachment.path),
      path: attachment.path,
      caption: attachment.caption,
      dataBase64: fileData.toString("base64")
    });
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse) {
    if (request.method === "POST" && request.url === "/channels/http/messages") {
      await this.handleMessageRequest(request, response);
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Not found." }));
  }

  private async handleMessageRequest(request: IncomingMessage, response: ServerResponse) {
    const body = await this.readJsonBody(request);
    const payload = this.validateRequestBody(body);
    const chatId = payload.chatId ?? this.deriveChatId(request);
    const files = payload.files
      ? await Promise.all(
        payload.files.map(async (file) => {
          const data = Uint8Array.from(Buffer.from(file.dataBase64, "base64"));
          const storedFile = await this.attachmentStore.save({
            data,
            filename: file.filename
          });

          return {
            mimeType: file.mimeType ?? "application/octet-stream",
            originalName: storedFile.originalName,
            path: storedFile.path,
            sizeBytes: storedFile.sizeBytes,
            caption: file.caption
          };
        })
      )
      : undefined;

    response.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive"
    });

    const replyStream = this.createHttpReplyStream(response);
    this.attachReplyStream(chatId, replyStream);

    try {
      await this.onMessage({
        channel: this.name,
        chatId,
        text: payload.text,
        images: payload.images?.map((image) => ({
          mimeType: image.mimeType,
          data: Uint8Array.from(Buffer.from(image.dataBase64, "base64")),
          caption: image.caption
        })),
        files
      });
    } finally {
      this.detachReplyStream(chatId);

      if (!response.writableEnded) {
        response.end();
      }
    }
  }

  private async readJsonBody(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];

    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const rawBody = Buffer.concat(chunks).toString("utf8");

    if (rawBody.trim() === "") {
      throw new Error("Request body is required.");
    }

    return JSON.parse(rawBody) as unknown;
  }

  private validateRequestBody(value: unknown): HttpRequestBody {
    if (!value || typeof value !== "object") {
      throw new Error("HTTP request must be a JSON object.");
    }

    const chatId = (value as { chatId?: unknown }).chatId;
    const text = (value as { text?: unknown }).text;
    const images = (value as { images?: unknown }).images;
    const files = (value as { files?: unknown }).files;

    if (chatId !== undefined && (typeof chatId !== "string" || chatId.trim() === "")) {
      throw new Error("`chatId` must be a non-empty string when provided.");
    }

    if (typeof text !== "string" || text.trim() === "") {
      throw new Error("`text` must be a non-empty string.");
    }

    if (images !== undefined) {
      if (!Array.isArray(images)) {
        throw new Error("`images` must be an array when provided.");
      }

      for (const [index, image] of images.entries()) {
        if (!image || typeof image !== "object") {
          throw new Error(`images[${index}] must be an object.`);
        }

        const mimeType = (image as { mimeType?: unknown }).mimeType;
        const dataBase64 = (image as { dataBase64?: unknown }).dataBase64;
        const caption = (image as { caption?: unknown }).caption;

        if (typeof mimeType !== "string" || mimeType.trim() === "") {
          throw new Error(`images[${index}].mimeType must be a non-empty string.`);
        }

        if (typeof dataBase64 !== "string" || dataBase64.trim() === "") {
          throw new Error(`images[${index}].dataBase64 must be a non-empty string.`);
        }

        if (caption !== undefined && typeof caption !== "string") {
          throw new Error(`images[${index}].caption must be a string when provided.`);
        }
      }
    }

    if (files !== undefined) {
      if (!Array.isArray(files)) {
        throw new Error("`files` must be an array when provided.");
      }

      for (const [index, file] of files.entries()) {
        if (!file || typeof file !== "object") {
          throw new Error(`files[${index}] must be an object.`);
        }

        const filename = (file as { filename?: unknown }).filename;
        const mimeType = (file as { mimeType?: unknown }).mimeType;
        const dataBase64 = (file as { dataBase64?: unknown }).dataBase64;
        const caption = (file as { caption?: unknown }).caption;

        if (filename !== undefined && (typeof filename !== "string" || filename.trim() === "")) {
          throw new Error(`files[${index}].filename must be a non-empty string when provided.`);
        }

        if (mimeType !== undefined && (typeof mimeType !== "string" || mimeType.trim() === "")) {
          throw new Error(`files[${index}].mimeType must be a non-empty string when provided.`);
        }

        if (typeof dataBase64 !== "string" || dataBase64.trim() === "") {
          throw new Error(`files[${index}].dataBase64 must be a non-empty string.`);
        }

        if (caption !== undefined && typeof caption !== "string") {
          throw new Error(`files[${index}].caption must be a string when provided.`);
        }
      }
    }

    return {
      chatId: typeof chatId === "string" ? chatId.trim() : undefined,
      text,
      images: Array.isArray(images)
        ? images.map((image) => ({
          mimeType: (image as { mimeType: string }).mimeType.trim(),
          dataBase64: (image as { dataBase64: string }).dataBase64.trim(),
          caption:
            typeof (image as { caption?: unknown }).caption === "string"
              ? (image as { caption: string }).caption
              : undefined
        }))
        : undefined,
      files: Array.isArray(files)
        ? files.map((file) => ({
          filename:
            typeof (file as { filename?: unknown }).filename === "string"
              ? (file as { filename: string }).filename.trim()
              : undefined,
          mimeType:
            typeof (file as { mimeType?: unknown }).mimeType === "string"
              ? (file as { mimeType: string }).mimeType.trim()
              : undefined,
          dataBase64: (file as { dataBase64: string }).dataBase64.trim(),
          caption:
            typeof (file as { caption?: unknown }).caption === "string"
              ? (file as { caption: string }).caption
              : undefined
        }))
        : undefined
    };
  }

  private deriveChatId(request: IncomingMessage): string {
    const protocol = this.getForwardedHeaderValue(request.headers["x-forwarded-proto"]) ?? "http";
    const host =
      this.getForwardedHeaderValue(request.headers["x-forwarded-host"]) ??
      this.getForwardedHeaderValue(request.headers.host);

    if (!host) {
      throw new Error("Unable to derive HTTP chat ID without a Host header.");
    }

    const accessUrl = `${protocol}://${host}`;
    return this.encodeChatId(accessUrl);
  }

  private getForwardedHeaderValue(value: string | string[] | undefined): string | undefined {
    if (Array.isArray(value)) {
      return this.getForwardedHeaderValue(value[0]);
    }

    if (typeof value !== "string") {
      return undefined;
    }

    const firstValue = value.split(",")[0]?.trim();
    return firstValue ? firstValue : undefined;
  }

  private encodeChatId(input: string): string {
    const digest = createHash("sha256").update(input).digest();
    let value = 0n;

    for (const byte of digest.subarray(0, 8)) {
      value = (value << 8n) | BigInt(byte);
    }

    return (value % 10_000_000_000n).toString().padStart(10, "0");
  }

  private createHttpReplyStream(response: ServerResponse): HttpReplyStream {
    const writeEvent = async (
      event: HttpChannelEvent
    ) => {
      if (response.writableEnded) {
        return;
      }

      response.write(`${JSON.stringify(event)}\n`);
    };

    return {
      async write(delta) {
        await writeEvent({ type: "delta", delta });
      },
      async finish() {
        await writeEvent({ type: "finish" });
      },
      async fail(message) {
        await writeEvent({ type: "error", message });
      },
      writeEvent
    };
  }

  private attachReplyStream(chatId: string, replyStream: HttpReplyStream) {
    if (this.replyStreams.has(chatId)) {
      throw new Error(`An HTTP reply stream is already active for chat ${chatId}.`);
    }

    this.replyStreams.set(chatId, replyStream);
  }

  private detachReplyStream(chatId: string) {
    this.replyStreams.delete(chatId);
  }
}
