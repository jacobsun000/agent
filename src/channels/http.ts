import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { type InboundMessage, type OutboundMessageStream } from "@/bus/bus";
import { type Channel } from "@/channels/types";
import { createLogger } from "@/utils/logger";

type HttpChannelConfig = {
  host: string;
  port: number;
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
};

const logger = createLogger("channel:http");

export class HttpChannel implements Channel {
  readonly name = "http" as const;
  private readonly host: string;
  private readonly port: number;
  private readonly onMessage: HttpChannelConfig["onMessage"];
  private readonly replyStreams = new Map<string, OutboundMessageStream>();
  private server?: Server;

  constructor(config: HttpChannelConfig) {
    this.host = config.host;
    this.port = config.port;
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

  async createReplyStream(chatId: string): Promise<OutboundMessageStream> {
    const replyStream = this.replyStreams.get(chatId);

    if (!replyStream) {
      throw new Error(`No HTTP reply stream registered for chat ${chatId}.`);
    }

    return replyStream;
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
        }))
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

  private createHttpReplyStream(response: ServerResponse): OutboundMessageStream {
    const writeEvent = async (
      event:
        | { type: "delta"; delta: string }
        | { type: "finish" }
        | { type: "error"; message: string }
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
      }
    };
  }

  private attachReplyStream(chatId: string, replyStream: OutboundMessageStream) {
    if (this.replyStreams.has(chatId)) {
      throw new Error(`An HTTP reply stream is already active for chat ${chatId}.`);
    }

    this.replyStreams.set(chatId, replyStream);
  }

  private detachReplyStream(chatId: string) {
    this.replyStreams.delete(chatId);
  }
}
