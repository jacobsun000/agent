import { readFile, writeFile } from "node:fs/promises";
import { applyEdits, modify, parse } from "jsonc-parser";

import { CONFIG_FILE_PATH, loadConfig, type Config } from "@/utils/config";
import {
  isDeferredSessionTarget,
  resolveSessionTarget,
  type SessionTarget
} from "@/utils/session-target";
import { pathExists } from "@/utils/utils";

const JSONC_FORMATTING_OPTIONS = {
  insertSpaces: true,
  tabSize: 2
} as const;

export function getConfiguredReportSession(
  config: Config,
  scope: "heartbeat" | "cron"
): SessionTarget | undefined {
  const value = scope === "heartbeat"
    ? config.heartbeat.reportSession
    : config.cron.reportSession;

  return resolveSessionTarget(value, `${scope}.reportSession`);
}

export function loadConfiguredReportSession(scope: "heartbeat" | "cron"): SessionTarget | undefined {
  return getConfiguredReportSession(loadConfig(), scope);
}

export async function initializeDeferredTelegramReportSessions(sessionKey: string): Promise<boolean> {
  if (!sessionKey.startsWith("telegram:")) {
    return false;
  }

  if (!(await pathExists(CONFIG_FILE_PATH))) {
    return false;
  }

  const sourceText = await readFile(CONFIG_FILE_PATH, "utf8");
  const parsed = parse(sourceText) as Record<string, unknown>;
  const heartbeatReportSession = getNestedString(parsed, ["heartbeat", "reportSession"]);
  const cronReportSession = getNestedString(parsed, ["cron", "reportSession"]);
  const edits = [
    ...(isDeferredSessionTarget(heartbeatReportSession ?? "")
      ? modify(sourceText, ["heartbeat", "reportSession"], sessionKey, {
          formattingOptions: JSONC_FORMATTING_OPTIONS
        })
      : []),
    ...(isDeferredSessionTarget(cronReportSession ?? "")
      ? modify(sourceText, ["cron", "reportSession"], sessionKey, {
          formattingOptions: JSONC_FORMATTING_OPTIONS
        })
      : [])
  ];

  if (edits.length === 0) {
    return false;
  }

  await writeFile(CONFIG_FILE_PATH, applyEdits(sourceText, edits), "utf8");
  return true;
}

function getNestedString(value: Record<string, unknown>, path: string[]): string | undefined {
  let current: unknown = value;

  for (const key of path) {
    if (!current || typeof current !== "object") {
      return undefined;
    }

    current = (current as Record<string, unknown>)[key];
  }

  return typeof current === "string" ? current : undefined;
}
