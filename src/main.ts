import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { runCliClient } from "@/services/cli-client";
import { startGateway } from "@/services/gateway";
import { bootstrapWorkspace } from "@/utils/bootstrap";
import { loadConfig } from "@/utils/config";
import { createLogger } from "@/utils/logger";

const logger = createLogger("main");

async function main() {
  await bootstrapWorkspace();

  await yargs(hideBin(process.argv))
    .scriptName("agent")
    .command(
      "gateway",
      "Start the main gateway service",
      async (argv) => {
        const config = loadConfig();
        const gateway = await startGateway();

        let shuttingDown = false;
        const shutdown = async () => {
          if (shuttingDown) {
            return;
          }

          shuttingDown = true;
          await gateway.stop();
        };

        process.once("SIGINT", () => {
          void shutdown();
        });

        process.once("SIGTERM", () => {
          void shutdown();
        });

        try {
          await gateway.waitUntilStopped();
        } finally {
          await shutdown();
        }
      }
    )
    .command(
      "cli",
      "Open a local CLI session that talks to the gateway",
      (command) =>
        command
          .option("url", {
            type: "string",
            describe: "Gateway base URL"
          })
          .option("session", {
            type: "string",
            describe: "Conversation/session identifier for the CLI chat"
          }),
      async (argv) => {
        const config = loadConfig();
        await runCliClient({
          baseUrl: argv.url ?? config.channels.http.url,
          chatId: argv.session
        });
      }
    )
    .demandCommand(1, "Choose `gateway` or `cli`.")
    .strict()
    .help()
    .parseAsync();
}

main().catch((error) => {
  logger.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
