import { ModelMessage } from "ai";

export function formatDateParts(value: Date): { day: string; minute: string } {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  const hours = String(value.getHours()).padStart(2, "0");
  const minutes = String(value.getMinutes()).padStart(2, "0");

  return {
    day: `${year}-${month}-${day}`,
    minute: `${year}-${month}-${day} ${hours}:${minutes}`
  };
}

export function serializeContent(content: ModelMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .map((part) => {
      const toolName =
        "toolName" in part && typeof part.toolName === "string" ? part.toolName : "unknown";

      if ("text" in part && typeof part.text === "string") {
        return part.text;
      }

      if ("input" in part) {
        return `[tool-call:${toolName}] ${JSON.stringify(part.input)}`;
      }

      if ("output" in part) {
        return `[tool-result:${toolName}] ${JSON.stringify(part.output)}`;
      }

      if ("errorText" in part && typeof part.errorText === "string") {
        return `[tool-error:${toolName}] ${part.errorText}`;
      }

      if ("providerExecuted" in part && "providerMetadata" in part) {
        return JSON.stringify(part);
      }

      return JSON.stringify(part);
    })
    .filter((value) => value.trim() !== "")
    .join("\n");
}

export function serializeMessage(message: ModelMessage, timestamp: string): string {
  const body = serializeContent(message.content);
  const lines = body === "" ? ["[empty]"] : body.split("\n");
  return [`[${timestamp}] ${message.role}`, ...lines, ""].join("\n");
}
