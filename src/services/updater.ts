import { type Config } from "@/utils/config";
import { createLogger } from "@/utils/logger";
import { restartInstalledGatewayService } from "@/utils/service";
import { applyGatewayUpdate } from "@/utils/update";

const logger = createLogger("updater");

type UpdaterServiceOptions = {
  config: Config;
};

export class UpdaterService {
  private readonly config: Config["updater"];
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | undefined;
  private runPromise: Promise<void> | undefined;
  private stopped = false;

  constructor(options: UpdaterServiceOptions) {
    this.config = options.config.updater;
    this.intervalMs = Number(this.config.interval) * 1000;
  }

  start() {
    if (!this.config.enabled) {
      logger.info("Auto-update is disabled.");
      return;
    }

    logger.info(
      `Auto-update enabled for ${this.config.remote}/${this.config.branch ?? "[current-branch]"} every ${this.intervalMs / 1000}s.`
    );
    this.scheduleNext(this.intervalMs);
  }

  async stop() {
    this.stopped = true;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    if (this.runPromise) {
      await this.runPromise;
    }
  }

  private scheduleNext(delayMs: number) {
    if (this.stopped || !this.config.enabled) {
      return;
    }

    this.timer = setTimeout(() => {
      void this.runCycle();
    }, delayMs);
  }

  private async runCycle() {
    if (this.runPromise) {
      logger.warn("Skipping auto-update tick because a previous update check is still active.");
      this.scheduleNext(this.intervalMs);
      return;
    }

    this.runPromise = this.executeCycle().finally(() => {
      this.runPromise = undefined;
      this.scheduleNext(this.intervalMs);
    });

    await this.runPromise;
  }

  private async executeCycle() {
    try {
      const result = await applyGatewayUpdate({
        repoRoot: this.config.repoRoot ?? process.cwd(),
        remote: this.config.remote,
        branch: this.config.branch,
        installDependencies: this.config.installDependencies
      });

      if (result.status === "up_to_date") {
        logger.debug(result.summary);
        return;
      }

      if (!result.applied) {
        logger.warn(result.summary);
        return;
      }

      logger.info(result.summary);

      if (!this.config.restartOnUpdate) {
        logger.info("Gateway restart after update is disabled.");
        return;
      }

      const restarted = await restartInstalledGatewayService();
      if (restarted) {
        logger.info("Restarted installed gateway service after applying update.");
      } else {
        logger.warn("Applied update, but no installed gateway service was found to restart.");
      }
    } catch (error) {
      logger.error(error instanceof Error ? error.message : error);
    }
  }
}

