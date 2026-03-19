import { randomUUID } from "node:crypto";
import type { LanguageModel } from "ai";

import { getCodexAuthSession } from "@/utils/codex-auth";

const DEFAULT_CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const DEFAULT_ORIGINATOR = "agent";

type CodexTool = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

type CodexInputItem = Record<string, unknown>;

type CodexCallOptions = {
  prompt: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  toolChoice?: { type: string; toolName?: string };
  maxOutputTokens?: number;
  temperature?: number;
  abortSignal?: AbortSignal;
  includeRawChunks?: boolean;
  providerOptions?: Record<string, unknown>;
  headers?: Record<string, string | undefined>;
};

type CodexUsage = {
  inputTokens: {
    total: number | undefined;
    noCache: number | undefined;
    cacheRead: number | undefined;
    cacheWrite: number | undefined;
  };
  outputTokens: {
    total: number | undefined;
    text: number | undefined;
    reasoning: number | undefined;
  };
  raw?: Record<string, unknown>;
};

type CodexFinishReason = {
  unified: "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other";
  raw: string | undefined;
};

type CodexStreamPart = {
  type: string;
  [key: string]: unknown;
};

type CodexWarning = {
  type: "unsupported" | "compatibility" | "other";
  feature?: string;
  details?: string;
  message?: string;
};

type ToolCallBuffer = {
  itemId: string;
  toolName: string;
  argumentsText: string;
  emittedToolInputStart: boolean;
};

type CodexStreamHandlers = {
  onEvent: (event: Record<string, unknown>) => void;
  onTextDelta: (delta: string) => void;
  onToolInputStart: (id: string, toolName: string) => void;
  onToolInputDelta: (id: string, delta: string) => void;
  onToolInputEnd: (id: string) => void;
  onToolCall: (id: string, toolName: string, input: string) => void;
};

type CodexStreamResult = {
  text: string;
  toolCalls: Array<{ toolCallId: string; toolName: string; input: string }>;
  usage: CodexUsage;
  finishReason: CodexFinishReason;
  responseHeaders: Record<string, string>;
};

type CodexProviderOptions = {
  reasoningEffort?: string;
  textVerbosity?: "low" | "medium" | "high";
  endpoint?: string;
  originator?: string;
  promptCacheKey?: string;
};

function stripModelPrefix(modelId: string): string {
  if (modelId.startsWith("openai-codex/") || modelId.startsWith("openai_codex/")) {
    return modelId.slice(modelId.indexOf("/") + 1);
  }

  return modelId;
}

function getProviderOptions(value: unknown): CodexProviderOptions {
  if (!value || typeof value !== "object") {
    return {};
  }

  const root = value as Record<string, unknown>;
  const codex = root.codex;
  if (!codex || typeof codex !== "object") {
    return {};
  }

  const options = codex as Record<string, unknown>;
  return {
    reasoningEffort: typeof options.reasoningEffort === "string" ? options.reasoningEffort : undefined,
    textVerbosity: options.textVerbosity === "low" || options.textVerbosity === "medium" || options.textVerbosity === "high"
      ? options.textVerbosity
      : undefined,
    endpoint: typeof options.endpoint === "string" && options.endpoint.trim() !== "" ? options.endpoint : undefined,
    originator: typeof options.originator === "string" && options.originator.trim() !== "" ? options.originator : undefined,
    promptCacheKey: typeof options.promptCacheKey === "string" && options.promptCacheKey.trim() !== ""
      ? options.promptCacheKey
      : undefined
  };
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toJsonString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function toHeadersObject(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

function parseToolCallId(value: unknown): { callId: string; itemId?: string } {
  if (typeof value !== "string" || value.trim() === "") {
    return { callId: "call_0" };
  }

  if (value.includes("|")) {
    const [callId, itemId] = value.split("|", 2);
    return {
      callId: callId || "call_0",
      itemId: itemId || undefined
    };
  }

  return { callId: value };
}

function getHeaderValue(headers: Record<string, string | undefined> | undefined, name: string): string | undefined {
  if (!headers) {
    return undefined;
  }

  const normalizedName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === normalizedName && typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }

  return undefined;
}

function resolvePromptCacheKey(options: CodexCallOptions, defaultPromptCacheKey: string): string {
  const providerOptions = getProviderOptions(options.providerOptions);

  return providerOptions.promptCacheKey
    ?? getHeaderValue(options.headers, "session_id")
    ?? getHeaderValue(options.headers, "x-client-request-id")
    ?? defaultPromptCacheKey;
}

function convertTools(tools: Array<Record<string, unknown>> | undefined): { tools: CodexTool[]; warnings: CodexWarning[] } {
  if (!tools || tools.length === 0) {
    return { tools: [], warnings: [] };
  }

  const converted: CodexTool[] = [];
  const warnings: CodexWarning[] = [];

  for (const tool of tools) {
    if (tool.type !== "function") {
      warnings.push({
        type: "unsupported",
        feature: "provider-tools",
        details: "Codex provider supports function tools only. Provider tools were ignored."
      });
      continue;
    }

    const name = getString(tool.name);
    if (!name) {
      continue;
    }

    converted.push({
      type: "function",
      name,
      description: getString(tool.description) ?? "",
      parameters: (tool.inputSchema as Record<string, unknown>) ?? {}
    });
  }

  return { tools: converted, warnings };
}

function convertUserMessage(message: Record<string, unknown>): CodexInputItem {
  const content = message.content;

  if (typeof content === "string") {
    return { role: "user", content: [{ type: "input_text", text: content }] };
  }

  if (!Array.isArray(content)) {
    return { role: "user", content: [{ type: "input_text", text: "" }] };
  }

  const converted: Array<Record<string, unknown>> = [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const part = item as Record<string, unknown>;
    if (part.type === "text") {
      converted.push({
        type: "input_text",
        text: getString(part.text) ?? ""
      });
      continue;
    }

    if (part.type === "file") {
      const mediaType = getString(part.mediaType) ?? "";
      const data = part.data;

      if (typeof data === "string" && /^https?:\/\//i.test(data) && mediaType.startsWith("image/")) {
        converted.push({
          type: "input_image",
          image_url: data,
          detail: "auto"
        });
        continue;
      }

      if (typeof data === "string" && /^https?:\/\//i.test(data)) {
        converted.push({
          type: "input_text",
          text: `[File URL: ${data}]`
        });
      }
    }
  }

  if (converted.length === 0) {
    converted.push({
      type: "input_text",
      text: ""
    });
  }

  return {
    role: "user",
    content: converted
  };
}

function convertPrompt(prompt: Array<Record<string, unknown>>): { instructions: string; input: CodexInputItem[] } {
  const systemPrompts: string[] = [];
  const input: CodexInputItem[] = [];

  for (const [index, message] of prompt.entries()) {
    const role = getString(message.role);
    const content = message.content;

    if (role === "system") {
      if (typeof content === "string" && content.trim() !== "") {
        systemPrompts.push(content);
      }
      continue;
    }

    if (role === "user") {
      input.push(convertUserMessage(message));
      continue;
    }

    if (role === "assistant") {
      if (Array.isArray(content)) {
        const textParts: string[] = [];

        for (const partValue of content) {
          if (!partValue || typeof partValue !== "object") {
            continue;
          }

          const part = partValue as Record<string, unknown>;
          if (part.type === "text" || part.type === "reasoning") {
            const text = getString(part.text);
            if (text) {
              textParts.push(text);
            }
            continue;
          }

          if (part.type === "tool-call") {
            const parsedToolCallId = parseToolCallId(part.toolCallId);
            const itemId = parsedToolCallId.itemId ?? `fc_${index}`;
            input.push({
              type: "function_call",
              id: itemId,
              call_id: parsedToolCallId.callId,
              name: getString(part.toolName),
              arguments: toJsonString(part.input)
            });
            continue;
          }

          if (part.type === "tool-result") {
            const parsedToolCallId = parseToolCallId(part.toolCallId);
            input.push({
              type: "function_call_output",
              call_id: parsedToolCallId.callId,
              output: toJsonString(part.output)
            });
          }
        }

        if (textParts.length > 0) {
          input.push({
            type: "message",
            role: "assistant",
            content: [{
              type: "output_text",
              text: textParts.join("")
            }],
            status: "completed",
            id: `msg_${index}`
          });
        }
      } else if (typeof content === "string" && content !== "") {
        input.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: content }],
          status: "completed",
          id: `msg_${index}`
        });
      }

      continue;
    }

    if (role === "tool" && Array.isArray(content)) {
      for (const partValue of content) {
        if (!partValue || typeof partValue !== "object") {
          continue;
        }

        const part = partValue as Record<string, unknown>;
        if (part.type !== "tool-result") {
          continue;
        }

        const parsedToolCallId = parseToolCallId(part.toolCallId);
        input.push({
          type: "function_call_output",
          call_id: parsedToolCallId.callId,
          output: toJsonString(part.output)
        });
      }
    }
  }

  return {
    instructions: systemPrompts.join("\n\n"),
    input
  };
}

function mapFinishReason(status: string | undefined, hasToolCalls: boolean): CodexFinishReason {
  if (hasToolCalls) {
    return {
      unified: "tool-calls",
      raw: status
    };
  }

  switch (status) {
    case "completed":
      return { unified: "stop", raw: status };
    case "incomplete":
      return { unified: "length", raw: status };
    case "failed":
    case "cancelled":
      return { unified: "error", raw: status };
    default:
      return { unified: "other", raw: status };
  }
}

function mapUsage(rawUsage: unknown): CodexUsage {
  const usage = (rawUsage && typeof rawUsage === "object" && !Array.isArray(rawUsage))
    ? rawUsage as Record<string, unknown>
    : {};
  const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : undefined;
  const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : undefined;

  const inputDetails = (usage.input_tokens_details && typeof usage.input_tokens_details === "object")
    ? usage.input_tokens_details as Record<string, unknown>
    : {};
  const outputDetails = (usage.output_tokens_details && typeof usage.output_tokens_details === "object")
    ? usage.output_tokens_details as Record<string, unknown>
    : {};

  const cachedRead = typeof inputDetails.cached_tokens === "number" ? inputDetails.cached_tokens : undefined;
  const reasoning = typeof outputDetails.reasoning_tokens === "number" ? outputDetails.reasoning_tokens : undefined;
  const noCache = typeof inputTokens === "number" && typeof cachedRead === "number"
    ? Math.max(0, inputTokens - cachedRead)
    : undefined;

  return {
    inputTokens: {
      total: inputTokens,
      noCache,
      cacheRead: cachedRead,
      cacheWrite: undefined
    },
    outputTokens: {
      total: outputTokens,
      text: typeof outputTokens === "number" && typeof reasoning === "number"
        ? Math.max(0, outputTokens - reasoning)
        : outputTokens,
      reasoning
    },
    raw: usage
  };
}

async function* iterateSseEvents(stream: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      let lineBreakIndex = buffer.indexOf("\n");
      const eventLines: string[] = [];

      while (lineBreakIndex >= 0) {
        const line = buffer.slice(0, lineBreakIndex).replace(/\r$/, "");
        buffer = buffer.slice(lineBreakIndex + 1);

        if (line === "") {
          if (eventLines.length > 0) {
            const data = eventLines
              .filter((entry) => entry.startsWith("data:"))
              .map((entry) => entry.slice(5).trim())
              .join("\n")
              .trim();

            eventLines.length = 0;
            if (data === "" || data === "[DONE]") {
              lineBreakIndex = buffer.indexOf("\n");
              continue;
            }

            try {
              const parsed = JSON.parse(data) as Record<string, unknown>;
              yield parsed;
            } catch {
              // ignore malformed chunks
            }
          }

          lineBreakIndex = buffer.indexOf("\n");
          continue;
        }

        eventLines.push(line);
        lineBreakIndex = buffer.indexOf("\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function requestCodex({
  options,
  body,
  streamHandlers
}: {
  options: CodexCallOptions;
  body: Record<string, unknown>;
  streamHandlers: CodexStreamHandlers;
}): Promise<CodexStreamResult> {
  const session = await getCodexAuthSession();
  const providerOptions = getProviderOptions(options.providerOptions);

  const requestHeaders = new Headers({
    Authorization: `Bearer ${session.accessToken}`,
    "chatgpt-account-id": session.accountId,
    "OpenAI-Beta": "responses=experimental",
    originator: providerOptions.originator ?? DEFAULT_ORIGINATOR,
    "User-Agent": "agent (typescript)",
    accept: "text/event-stream",
    "content-type": "application/json"
  });

  if (options.headers) {
    for (const [key, value] of Object.entries(options.headers)) {
      if (typeof value === "string" && value !== "") {
        requestHeaders.set(key, value);
      }
    }
  }

  const endpoint = providerOptions.endpoint ?? DEFAULT_CODEX_RESPONSES_URL;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify(body),
    signal: options.abortSignal
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const suffix = text.trim() === "" ? "" : `: ${text}`;
    throw new Error(`Codex request failed (${response.status})${suffix}`);
  }

  if (!response.body) {
    throw new Error("Codex request failed: missing response body.");
  }

  const toolCallBuffers = new Map<string, ToolCallBuffer>();
  const toolCalls: Array<{ toolCallId: string; toolName: string; input: string }> = [];
  let text = "";
  let status: string | undefined;
  let rawUsage: unknown;

  for await (const event of iterateSseEvents(response.body)) {
    streamHandlers.onEvent(event);
    const eventType = getString(event.type);
    if (!eventType) {
      continue;
    }

    if (eventType === "response.output_text.delta") {
      const delta = getString(event.delta) ?? "";
      text += delta;
      streamHandlers.onTextDelta(delta);
      continue;
    }

    if (eventType === "response.output_item.added") {
      const item = event.item;
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }

      const typedItem = item as Record<string, unknown>;
      if (typedItem.type !== "function_call") {
        continue;
      }

      const callId = getString(typedItem.call_id);
      if (!callId) {
        continue;
      }

      const itemId = getString(typedItem.id) ?? `fc_${toolCallBuffers.size}`;
      const toolName = getString(typedItem.name) ?? "unknown_tool";
      const argumentsText = getString(typedItem.arguments) ?? "";

      toolCallBuffers.set(callId, {
        itemId,
        toolName,
        argumentsText,
        emittedToolInputStart: false
      });
      continue;
    }

    if (eventType === "response.function_call_arguments.delta") {
      const callId = getString(event.call_id);
      if (!callId) {
        continue;
      }

      const buffer = toolCallBuffers.get(callId);
      if (!buffer) {
        continue;
      }

      if (!buffer.emittedToolInputStart) {
        streamHandlers.onToolInputStart(callId, buffer.toolName);
        buffer.emittedToolInputStart = true;
      }

      const delta = getString(event.delta) ?? "";
      buffer.argumentsText += delta;
      streamHandlers.onToolInputDelta(callId, delta);
      continue;
    }

    if (eventType === "response.function_call_arguments.done") {
      const callId = getString(event.call_id);
      if (!callId) {
        continue;
      }

      const buffer = toolCallBuffers.get(callId);
      if (!buffer) {
        continue;
      }

      const argumentsText = getString(event.arguments);
      if (argumentsText !== undefined) {
        buffer.argumentsText = argumentsText;
      }
      continue;
    }

    if (eventType === "response.output_item.done") {
      const item = event.item;
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }

      const typedItem = item as Record<string, unknown>;
      if (typedItem.type !== "function_call") {
        continue;
      }

      const callId = getString(typedItem.call_id);
      if (!callId) {
        continue;
      }

      const buffer = toolCallBuffers.get(callId);
      if (!buffer) {
        continue;
      }

      if (buffer.emittedToolInputStart) {
        streamHandlers.onToolInputEnd(callId);
      }

      const input = buffer.argumentsText || "{}";
      const toolCall = {
        toolCallId: `${callId}|${buffer.itemId}`,
        toolName: buffer.toolName,
        input
      };
      toolCalls.push(toolCall);
      streamHandlers.onToolCall(callId, buffer.toolName, input);
      continue;
    }

    if (eventType === "response.completed") {
      const responseValue = event.response;
      if (!responseValue || typeof responseValue !== "object" || Array.isArray(responseValue)) {
        continue;
      }

      const typedResponse = responseValue as Record<string, unknown>;
      status = getString(typedResponse.status);
      rawUsage = typedResponse.usage;
    }
  }

  return {
    text,
    toolCalls,
    usage: mapUsage(rawUsage),
    finishReason: mapFinishReason(status, toolCalls.length > 0),
    responseHeaders: toHeadersObject(response.headers)
  };
}

function createLanguageModel(modelId: string) {
  const defaultPromptCacheKey = randomUUID();

  const model = {
    specificationVersion: "v3" as const,
    provider: "codex",
    modelId,
    supportedUrls: {
      "image/*": [/^https?:\/\//i],
      "*/*": [/^https?:\/\//i]
    },
    async doGenerate(options: CodexCallOptions) {
      const providerOptions = getProviderOptions(options.providerOptions);
      const convertedPrompt = convertPrompt(options.prompt);
      const convertedTools = convertTools(options.tools);

      const requestBody: Record<string, unknown> = {
        model: stripModelPrefix(modelId),
        store: false,
        stream: true,
        instructions: convertedPrompt.instructions,
        input: convertedPrompt.input,
        prompt_cache_key: resolvePromptCacheKey(options, defaultPromptCacheKey),
        parallel_tool_calls: true
      };

      if (convertedTools.tools.length > 0 && options.toolChoice?.type !== "none") {
        requestBody.tools = convertedTools.tools;
        requestBody.tool_choice = "auto";
      }

      if (typeof options.maxOutputTokens === "number") {
        requestBody.max_output_tokens = options.maxOutputTokens;
      }

      if (typeof options.temperature === "number") {
        requestBody.temperature = options.temperature;
      }

      if (providerOptions.reasoningEffort) {
        requestBody.reasoning = { effort: providerOptions.reasoningEffort };
      }

      if (providerOptions.textVerbosity) {
        requestBody.text = { verbosity: providerOptions.textVerbosity };
      }

      const result = await requestCodex({
        options,
        body: requestBody,
        streamHandlers: {
          onEvent: () => { },
          onTextDelta: () => { },
          onToolInputStart: () => { },
          onToolInputDelta: () => { },
          onToolInputEnd: () => { },
          onToolCall: () => { }
        }
      });

      const content: Array<Record<string, unknown>> = [];
      if (result.text !== "") {
        content.push({
          type: "text",
          text: result.text
        });
      }

      for (const toolCall of result.toolCalls) {
        content.push({
          type: "tool-call",
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          input: toolCall.input
        });
      }

      return {
        content,
        finishReason: result.finishReason,
        usage: result.usage,
        warnings: convertedTools.warnings,
        request: {
          body: requestBody
        },
        response: {
          modelId: stripModelPrefix(modelId),
          headers: result.responseHeaders
        }
      };
    },
    async doStream(options: CodexCallOptions) {
      const providerOptions = getProviderOptions(options.providerOptions);
      const convertedPrompt = convertPrompt(options.prompt);
      const convertedTools = convertTools(options.tools);

      const requestBody: Record<string, unknown> = {
        model: stripModelPrefix(modelId),
        store: false,
        stream: true,
        instructions: convertedPrompt.instructions,
        input: convertedPrompt.input,
        prompt_cache_key: resolvePromptCacheKey(options, defaultPromptCacheKey),
        parallel_tool_calls: true
      };

      if (convertedTools.tools.length > 0 && options.toolChoice?.type !== "none") {
        requestBody.tools = convertedTools.tools;
        requestBody.tool_choice = "auto";
      }

      if (typeof options.maxOutputTokens === "number") {
        requestBody.max_output_tokens = options.maxOutputTokens;
      }

      if (typeof options.temperature === "number") {
        requestBody.temperature = options.temperature;
      }

      if (providerOptions.reasoningEffort) {
        requestBody.reasoning = { effort: providerOptions.reasoningEffort };
      }

      if (providerOptions.textVerbosity) {
        requestBody.text = { verbosity: providerOptions.textVerbosity };
      }

      let responseHeaders: Record<string, string> = {};
      const stream = new ReadableStream<CodexStreamPart>({
        start: async (controller) => {
          let hasStartedText = false;
          const textId = "text_0";

          controller.enqueue({
            type: "stream-start",
            warnings: convertedTools.warnings
          });

          try {
            const result = await requestCodex({
              options,
              body: requestBody,
              streamHandlers: {
                onEvent: (event) => {
                  if (options.includeRawChunks) {
                    controller.enqueue({
                      type: "raw",
                      rawValue: event
                    });
                  }
                },
                onTextDelta: (delta) => {
                  if (!hasStartedText) {
                    controller.enqueue({
                      type: "text-start",
                      id: textId
                    });
                    hasStartedText = true;
                  }

                  controller.enqueue({
                    type: "text-delta",
                    id: textId,
                    delta
                  });
                },
                onToolInputStart: (id, toolName) => {
                  controller.enqueue({
                    type: "tool-input-start",
                    id,
                    toolName
                  });
                },
                onToolInputDelta: (id, delta) => {
                  controller.enqueue({
                    type: "tool-input-delta",
                    id,
                    delta
                  });
                },
                onToolInputEnd: (id) => {
                  controller.enqueue({
                    type: "tool-input-end",
                    id
                  });
                },
                onToolCall: (id, toolName, input) => {
                  controller.enqueue({
                    type: "tool-call",
                    toolCallId: id,
                    toolName,
                    input
                  });
                }
              }
            });

            responseHeaders = result.responseHeaders;

            if (hasStartedText) {
              controller.enqueue({
                type: "text-end",
                id: textId
              });
            }

            controller.enqueue({
              type: "finish",
              usage: result.usage,
              finishReason: result.finishReason
            });
            controller.close();
          } catch (error) {
            controller.enqueue({
              type: "error",
              error: error instanceof Error ? error.message : String(error)
            });
            controller.close();
          }
        }
      });

      return {
        stream,
        request: {
          body: requestBody
        },
        response: {
          headers: responseHeaders
        }
      };
    }
  };

  return model;
}

export type CodexProvider = {
  specificationVersion: "v3";
  languageModel: (modelId: string) => ReturnType<typeof createLanguageModel>;
  embeddingModel: (modelId: string) => never;
  imageModel: (modelId: string) => never;
};

export function createCodexProvider(): CodexProvider {
  return {
    specificationVersion: "v3",
    languageModel: (modelId: string) => createLanguageModel(modelId),
    embeddingModel: (modelId: string) => {
      throw new Error(`Codex provider does not support embedding models ('${modelId}').`);
    },
    imageModel: (modelId: string) => {
      throw new Error(`Codex provider does not support image models ('${modelId}').`);
    }
  };
}

export function createCodexLanguageModel(modelId: string): LanguageModel {
  const provider = createCodexProvider();
  return provider.languageModel(modelId) as unknown as LanguageModel;
}
