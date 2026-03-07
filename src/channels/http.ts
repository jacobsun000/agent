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
  chatId: string;
  text: string;
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

    response.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive"
    });

    const replyStream = this.createHttpReplyStream(response);
    this.attachReplyStream(payload.chatId, replyStream);

    try {
      await this.onMessage({
        channel: this.name,
        chatId: payload.chatId,
        text: payload.text
      });
    } finally {
      this.detachReplyStream(payload.chatId);

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

    if (typeof chatId !== "string" || chatId.trim() === "") {
      throw new Error("`chatId` must be a non-empty string.");
    }

    if (typeof text !== "string" || text.trim() === "") {
      throw new Error("`text` must be a non-empty string.");
    }

    return {
      chatId,
      text
    };
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
