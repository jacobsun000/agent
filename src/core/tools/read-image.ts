import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { tool } from "ai";
import { z } from "zod";

const readImageInputSchema = z.object({
  path: z.string().trim().min(1, "Path must not be empty."),
});

export function createReadImageTool() {
  return tool({
    title: "read_image",
    description: "Read a local image file and analyze it with the current model. Accepts a local file path and an optional analysis prompt.",
    inputSchema: readImageInputSchema,
    async execute(input) {
      const resolvedPath = path.resolve(input.path);
      await access(resolvedPath);

      const fileStat = await stat(resolvedPath);
      if (!fileStat.isFile()) {
        throw new Error("The requested path is not a regular file.");
      }

      const mediaType = getImageMediaType(resolvedPath);
      const image = await readFile(resolvedPath);
      return {
        type: 'media',
        data: image.toString('base64'),
        mediaType,
      };
    },

    // map to tool result content for LLM consumption:
    toModelOutput({ output }) {
      return {
        type: 'content',
        value: [{ type: 'media', data: output.data, mediaType: output.mediaType }],
      };
    },
  });
}

function getImageMediaType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();

  switch (extension) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    case ".tif":
    case ".tiff":
      return "image/tiff";
    default:
      throw new Error(`Unsupported image file extension '${extension || "[none]"}'. Supported extensions: .jpg, .jpeg, .png, .gif, .webp, .bmp, .tif, .tiff.`);
  }
}
