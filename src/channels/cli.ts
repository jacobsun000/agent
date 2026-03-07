import { type Channel } from "@/channels/types";
import { type InboundMessage, type OutboundMessageStream } from "@/bus/bus";
import { createLogger } from "@/utils/logger";

type CliChannelConfig = {
  onMessage: (message: InboundMessage) => Promise<void>;
};

const logger = createLogger("channel:cli");

export class CliChannel implements Channel {
  readonly name = "cli" as const;
  private readonly onMessage: CliChannelConfig["onMessage"];
  private stopped = false;

  constructor(config: CliChannelConfig) {
    this.onMessage = config.onMessage;
  }

  async start() {
    logger.box("CLI agent ready.\nType a request, or use `exit` to quit.");

    while (!this.stopped) {
      const userInput = await logger.prompt("", {
        placeholder: "Ask me to do something..."
      });

      if (userInput === "exit") {
        this.stopped = true;
        break;
      }

      if (typeof userInput !== "string" || userInput.trim() === "") {
        continue;
      }

      await this.onMessage({
        channel: this.name,
        chatId: "default",
        text: userInput,
      });
    }
  }

  async stop() {
    this.stopped = true;
  }

  async createReplyStream(): Promise<OutboundMessageStream> {
    let hasOutput = false;

    return {
      async write(delta) {
        if (!hasOutput) {
          process.stdout.write("\n");
          hasOutput = true;
        }

        process.stdout.write(delta);
      },
      async finish() {
        if (hasOutput) {
          process.stdout.write("\n");
        }
      },
      async fail(message) {
        if (hasOutput) {
          process.stdout.write("\n");
        }

        logger.error(message);
      }
    };
  }
}
