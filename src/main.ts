import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { runCliClient } from "@/services/cli-client";
import { startGateway } from "@/services/gateway";
import { bootstrapConfigInteractive, bootstrapWorkspace } from "@/utils/bootstrap";
import { loadConfig } from "@/utils/config";
import {
  createCodexAuthorizationFlow,
  exchangeCodexAuthorizationCode,
  parseCodexAuthorizationInput,
  saveCodexCredential
} from "@/utils/codex-auth";
import { createLogger } from "@/utils/logger";
import { approvePairingCode } from "@/utils/pairing";
import {
  getGatewayServiceStatus,
  installGatewayService,
  restartInstalledGatewayService,
  restartGatewayService,
  startGatewayService,
  stopGatewayService,
  uninstallGatewayService
} from "@/utils/service";
import { applyGatewayUpdate, checkGatewayUpdate } from "@/utils/update";

const logger = createLogger("main");

async function promptAuthorizationInput(question: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

async function runCodexAuthCommand(options: { code?: string; callback?: string }): Promise<void> {
  const flow = await createCodexAuthorizationFlow("agent");

  logger.box(`Codex OAuth
Open this URL in your browser and complete sign-in:
${flow.url}

After sign-in, copy either the callback URL or the 'code' value and paste it below.`);

  const providedInput = options.callback ?? options.code;
  const authInput = providedInput ?? await promptAuthorizationInput("Callback URL or code: ");
  const parsedInput = parseCodexAuthorizationInput(authInput);

  if (!parsedInput.code) {
    throw new Error("Missing OAuth authorization code.");
  }

  if (parsedInput.state && parsedInput.state !== flow.state) {
    throw new Error("OAuth state mismatch. Please restart with `agent auth codex`.");
  }

  const credential = await exchangeCodexAuthorizationCode(parsedInput.code, flow.verifier);
  await saveCodexCredential(credential);
  logger.info("Codex OAuth credentials saved to ~/.agent/auth.json.");
}

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

async function runUpdateCommand(options: {
  checkOnly: boolean;
  remote?: string;
  branch?: string;
  repoRoot?: string;
  restart: boolean;
  installDependencies?: boolean;
}): Promise<void> {
  const config = loadConfig();
  const repoRoot = options.repoRoot ?? config.updater.repoRoot ?? process.cwd();
  const installDependencies = options.installDependencies ?? config.updater.installDependencies;
  const result = options.checkOnly
    ? await checkGatewayUpdate({
        repoRoot,
        remote: options.remote ?? config.updater.remote,
        branch: options.branch ?? config.updater.branch,
        installDependencies
      })
    : await applyGatewayUpdate({
        repoRoot,
        remote: options.remote ?? config.updater.remote,
        branch: options.branch ?? config.updater.branch,
        installDependencies
      });

  logger.box(`Gateway Update
Status: ${result.status}
Repo: ${result.repoRoot}
Remote: ${result.remote}
Branch: ${result.branch}
Current: ${result.currentCommit}
Target: ${result.targetCommit}
Summary: ${result.summary}`);

  if (!options.checkOnly && result.applied && options.restart) {
    const restarted = await restartInstalledGatewayService();
    if (restarted) {
      logger.info("Restarted installed gateway service.");
    } else {
      logger.warn("Update applied, but no installed gateway service was found to restart.");
    }
  }
}

async function main() {
  await bootstrapWorkspace();

  await yargs(hideBin(process.argv))
    .scriptName("agent")
    .command(
      "auth",
      "Authenticate providers",
      (command) =>
        command
          .command(
            "codex",
            "Authenticate Codex OAuth and save credentials in ~/.agent/auth.json",
            (subCommand) =>
              subCommand
                .option("callback", {
                  type: "string",
                  describe: "Full OAuth callback URL"
                })
                .option("code", {
                  type: "string",
                  describe: "OAuth authorization code"
                }),
            async (argv) => {
              await runCodexAuthCommand({
                callback: argv.callback,
                code: argv.code
              });
            }
          )
          .demandCommand(1, "Choose an auth command: `codex`.")
          .strict()
    )
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
      "update",
      "Check for updates, pull from git, and optionally restart the installed gateway service",
      (command) =>
        command
          .option("check-only", {
            type: "boolean",
            default: false,
            describe: "Only check whether an update is available"
          })
          .option("remote", {
            type: "string",
            describe: "Git remote to fetch from"
          })
          .option("branch", {
            type: "string",
            describe: "Branch to update from"
          })
          .option("repo-root", {
            type: "string",
            describe: "Repository root to update"
          })
          .option("restart", {
            type: "boolean",
            default: true,
            describe: "Restart the installed gateway service after a successful update"
          })
          .option("install-dependencies", {
            type: "boolean",
            default: undefined,
            describe: "Run `pnpm install --frozen-lockfile` when package manifests changed"
          }),
      async (argv) => {
        await runUpdateCommand({
          checkOnly: argv.checkOnly,
          remote: argv.remote,
          branch: argv.branch,
          repoRoot: argv.repoRoot,
          restart: argv.restart,
          installDependencies: argv.installDependencies
        });
      }
    )
    .command(
      "bootstrap",
      "Interactively initialize ~/.agent/config.jsonc",
      () => {},
      async () => {
        await bootstrapConfigInteractive();
      }
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
    .demandCommand(1, "Choose `auth`, `gateway`, `update`, `bootstrap`, `pair`, or `cli`.")
    .strict()
    .help()
    .parseAsync();
}

main().catch((error) => {
  logger.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
