import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { runCliClient } from "@/services/cli-client";
import { startGateway } from "@/services/gateway";
import { bootstrapWorkspace } from "@/utils/bootstrap";
import { loadConfig } from "@/utils/config";
import { createLogger } from "@/utils/logger";
import { approvePairingCode } from "@/utils/pairing";
import {
  getGatewayServiceStatus,
  installGatewayService,
  restartGatewayService,
  startGatewayService,
  stopGatewayService,
  uninstallGatewayService
} from "@/utils/service";

const logger = createLogger("main");

async function runGatewayForeground(): Promise<void> {
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

async function main() {
  await bootstrapWorkspace();

  await yargs(hideBin(process.argv))
    .scriptName("agent")
    .command(
      "gateway",
      "Run the gateway in foreground or manage the installed service",
      (command) =>
        command
          .command(
            "run",
            "Run the gateway in the foreground",
            () => {},
            async () => {
              await runGatewayForeground();
            }
          )
          .command(
            "install",
            "Install the gateway as a user service",
            () => {},
            async () => {
              const definitionPath = await installGatewayService(process.cwd());
              logger.info(`Installed gateway service at ${definitionPath}.`);
            }
          )
          .command(
            "start",
            "Start the installed gateway service",
            () => {},
            async () => {
              await startGatewayService();
              logger.info("Started gateway service.");
            }
          )
          .command(
            "stop",
            "Stop the installed gateway service",
            () => {},
            async () => {
              await stopGatewayService();
              logger.info("Stopped gateway service.");
            }
          )
          .command(
            "restart",
            "Restart the installed gateway service",
            () => {},
            async () => {
              await restartGatewayService();
              logger.info("Restarted gateway service.");
            }
          )
          .command(
            "uninstall",
            "Uninstall the gateway service",
            () => {},
            async () => {
              await uninstallGatewayService();
              logger.info("Uninstalled gateway service.");
            }
          )
          .command(
            "status",
            "Show gateway service status",
            () => {},
            async () => {
              const status = await getGatewayServiceStatus();
              logger.box(`Gateway Service
Manager: ${status.manager}
Installed: ${status.installed ? "yes" : "no"}
Enabled: ${status.enabled ? "yes" : "no"}
Running: ${status.running ? "yes" : "no"}
Definition: ${status.definitionPath}`);
            }
          )
          .demandCommand(1, "Choose a gateway command: `run`, `start`, `stop`, `restart`, `install`, `uninstall`, or `status`.")
          .strict()
    )
    .command(
      "pair <code>",
      "Approve a pending pairing code",
      (command) =>
        command.positional("code", {
          type: "string",
          describe: "Six-digit pairing code"
        }),
      async (argv) => {
        if (!argv.code) {
          logger.error("Pairing code is required.");
          return;
        }

        try {
          const sessionKey = approvePairingCode(argv.code);
          logger.info(`Paired session ${sessionKey}.`);
        } catch (error) {
          logger.error(`Error approving pairing code: ${error instanceof Error ? error.message : error}`);
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
          }),
      async (argv) => {
        const config = loadConfig();
        await runCliClient({
          baseUrl: argv.url ?? config.channels.http.url
        });
      }
    )
    .demandCommand(1, "Choose `gateway`, `pair`, or `cli`.")
    .strict()
    .help()
    .parseAsync();
}

main().catch((error) => {
  logger.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
