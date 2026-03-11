import { access, stat } from "node:fs/promises";
import path from "node:path";

import { tool } from "ai";
import { z } from "zod";

const sendFileInputSchema = z.object({
  path: z.string().trim().min(1, "Path must not be empty."),
  filename: z.string().trim().min(1, "Filename must not be empty.").optional(),
  caption: z.string().trim().min(1, "Caption must not be empty.").optional()
});

type SendFileToolConfig = {
  enabled: boolean;
  onSend: (input: { path: string; filename?: string; caption?: string }) => Promise<void>;
};

export function createSendFileTool(config: SendFileToolConfig) {
  return tool({
    title: "send_file",
    description: config.enabled
      ? "Send a local file to the current user as an attachment. The file path may point anywhere on the computer."
      : "Unavailable in this context.",
    inputSchema: sendFileInputSchema,
    async execute(input) {
      if (!config.enabled) {
        throw new Error("The send_file tool is unavailable in this context.");
      }

      const resolvedPath = path.resolve(input.path);
      await access(resolvedPath);

      const fileStat = await stat(resolvedPath);
      if (!fileStat.isFile()) {
        throw new Error("The requested path is not a regular file.");
      }

      await config.onSend({
        path: resolvedPath,
        filename: input.filename,
        caption: input.caption
      });

      return {
        status: "sent" as const,
        path: resolvedPath,
        sizeBytes: fileStat.size,
        filename: input.filename ?? path.basename(resolvedPath)
      };
    }
  });
}
