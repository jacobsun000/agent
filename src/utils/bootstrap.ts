import { copyFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";

import { CONFIG_PATH, pathExists } from "@/utils/utils";

const TEMPLATE_ROOT = path.resolve(process.cwd(), "templates");
const WORKSPACE_PATH = path.join(CONFIG_PATH, "workspace");
const MEMORY_PATH = path.join(WORKSPACE_PATH, "memory");
const HISTORY_PATH = path.join(MEMORY_PATH, "history");
const NOTES_PATH = path.join(MEMORY_PATH, "notes");

async function copyMissingTree(sourcePath: string, destinationPath: string): Promise<void> {
  const entries = await readdir(sourcePath, { withFileTypes: true });
  await mkdir(destinationPath, { recursive: true });

  for (const entry of entries) {
    const sourceEntryPath = path.join(sourcePath, entry.name);
    const destinationEntryPath = path.join(destinationPath, entry.name);

    if (entry.isDirectory()) {
      await copyMissingTree(sourceEntryPath, destinationEntryPath);
      continue;
    }

    if (await pathExists(destinationEntryPath)) {
      continue;
    }

    await copyFile(sourceEntryPath, destinationEntryPath);
  }
}

export async function bootstrapWorkspace(): Promise<void> {
  await mkdir(CONFIG_PATH, { recursive: true });
  await copyMissingTree(TEMPLATE_ROOT, CONFIG_PATH);
  await mkdir(HISTORY_PATH, { recursive: true });
  await mkdir(NOTES_PATH, { recursive: true });
}
