import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { createLogger } from "@/utils/logger";

const logger = createLogger("cli");

type RunCliClientOptions = {
  baseUrl: string;
};

type HttpChannelEvent =
  | { type: "delta"; delta: string }
  | { type: "finish" }
  | { type: "error"; message: string }
  | { type: "attachment"; filename: string; path: string; caption?: string; dataBase64: string };

export async function runCliClient(options: RunCliClientOptions) {
  logger.box("CLI agent ready.\nType a request, or use `exit` to quit.");

  while (true) {
    const userInput = await logger.prompt("", {
      placeholder: "Ask me to do something..."
    });

    if (userInput === "exit") {
      return;
    }

    if (typeof userInput !== "string" || userInput.trim() === "") {
      continue;
    }

    await streamHttpReply({
      baseUrl: options.baseUrl,
      text: userInput
    });
  }
}

async function streamHttpReply(input: {
  baseUrl: string;
  text: string;
}) {
  const response = await fetch(new URL("/channels/http/messages", input.baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      text: input.text
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gateway request failed (${response.status}): ${errorText}`);
  }

  if (!response.body) {
    throw new Error("Gateway response did not include a body.");
  }

  let hasOutput = false;
  let buffer = "";
  const decoder = new TextDecoder();

  const flushLine = async (line: string) => {
    if (line.trim() === "") {
      return;
    }

    const event = JSON.parse(line) as HttpChannelEvent;

    if (event.type === "delta") {
      if (!hasOutput) {
        process.stdout.write("\n");
        hasOutput = true;
      }

      process.stdout.write(event.delta);
      return;
    }

    if (event.type === "error") {
      if (hasOutput) {
        process.stdout.write("\n");
      }

      logger.error(event.message);
      return;
    }

    if (event.type === "attachment") {
      if (hasOutput) {
        process.stdout.write("\n");
      }

      const savedPath = await saveAttachment(event);
      logger.info(`Attachment received: ${savedPath}`);
      if (event.caption) {
        logger.info(`Attachment caption: ${event.caption}`);
      }
      return;
    }

    if (event.type === "finish" && hasOutput) {
      process.stdout.write("\n");
    }
  };

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });

    while (true) {
      const lineBreakIndex = buffer.indexOf("\n");
      if (lineBreakIndex === -1) {
        break;
      }

      const line = buffer.slice(0, lineBreakIndex);
      buffer = buffer.slice(lineBreakIndex + 1);
      await flushLine(line);
    }
  }

  const trailing = buffer + decoder.decode();
  if (trailing.trim() !== "") {
    await flushLine(trailing);
  }
}

async function saveAttachment(event: Extract<HttpChannelEvent, { type: "attachment" }>): Promise<string> {
  const now = new Date();
  const monthDirectory = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const targetDirectory = path.join(homedir(), ".agent", "workspace", "download", "received", monthDirectory);
  await mkdir(targetDirectory, { recursive: true });

  const targetPath = path.join(targetDirectory, sanitizeFilename(event.filename));
  await writeFile(targetPath, Buffer.from(event.dataBase64, "base64"));
  return targetPath;
}

function sanitizeFilename(filename: string): string {
  const sanitized = path.basename(filename).replace(/[^a-zA-Z0-9._-]+/g, "-");
  return sanitized === "" ? "attachment.bin" : sanitized;
}
