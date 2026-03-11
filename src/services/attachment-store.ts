import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { CONFIG_PATH } from "@/utils/utils";

const DOWNLOAD_ROOT = path.join(CONFIG_PATH, "workspace", "download");

export type StoreAttachmentInput = {
  data: Uint8Array;
  filename?: string;
};

export type StoredAttachment = {
  originalName: string;
  path: string;
  sizeBytes: number;
};

export interface AttachmentStore {
  save(input: StoreAttachmentInput): Promise<StoredAttachment>;
}

export function createAttachmentStore(): AttachmentStore {
  return {
    async save(input) {
      const now = new Date();
      const monthDirectory = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const targetDirectory = path.join(DOWNLOAD_ROOT, monthDirectory);
      await mkdir(targetDirectory, { recursive: true });

      const normalizedFilename = normalizeFilename(input.filename);
      const parsed = path.parse(normalizedFilename);
      const uniqueName = `${parsed.name}-${randomUUID().slice(0, 8)}${parsed.ext}`;
      const targetPath = path.join(targetDirectory, uniqueName);

      await writeFile(targetPath, input.data);

      return {
        originalName: normalizedFilename,
        path: targetPath,
        sizeBytes: input.data.byteLength
      };
    }
  };
}

function normalizeFilename(filename?: string): string {
  const fallbackName = "attachment.bin";
  const trimmed = filename?.trim();

  if (!trimmed) {
    return fallbackName;
  }

  const basename = path.basename(trimmed);
  const sanitized = basename.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");

  if (sanitized === "" || sanitized === "." || sanitized === "..") {
    return fallbackName;
  }

  return sanitized;
}
