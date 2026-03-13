import { access } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const CONFIG_PATH = path.join(
  homedir(),
  ".agent",
);

export const WORKSPACE_PATH = `${CONFIG_PATH}/workspace`;

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

export function escapeTelegramMarkdownV2(value: string): string {
  return value.replaceAll(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}
