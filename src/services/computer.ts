import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import util from "node:util";

import OpenAI from "openai";
import { chromium, type BrowserContext, type Page } from "playwright";

import { createLogger } from "@/utils/logger";
import { loadConfig } from "@/utils/config";
import { parseModel } from "@/utils/model";
import { WORKSPACE_PATH } from "@/utils/utils";

const logger = createLogger("computer");

const BROWSER_ROOT_PATH = path.join(WORKSPACE_PATH, "browser");
const BROWSER_PROFILE_PATH = path.join(BROWSER_ROOT_PATH, "profile");
const BROWSER_ARTIFACTS_PATH = path.join(BROWSER_ROOT_PATH, "artifacts");
const DEFAULT_MODEL = "openai/gpt-5.4";
const DEFAULT_MAX_STEPS = 24;
const DEFAULT_REASONING_EFFORT = "low";
const DEFAULT_VIEWPORT = { width: 1440, height: 900 } as const;
const DEFAULT_SESSION_PREFIX = "browser";
const MAX_CODE_LENGTH = 12_000;

type ComputerUseSessionStatus = "idle" | "running" | "awaiting_user" | "completed";

type ComputerUseMessage = {
  phase: "commentary" | "final_answer" | "message";
  text: string;
};

type ComputerUseBaseResult = {
  sessionId: string;
  title: string | null;
  url: string | null;
  messages: ComputerUseMessage[];
};

export type ComputerUseRunResult =
  | (ComputerUseBaseResult & {
      status: "completed";
      answer: string;
      steps: number;
    })
  | (ComputerUseBaseResult & {
      status: "awaiting_user";
      question: string;
      steps: number;
    });

export type ComputerUseSessionSummary = {
  sessionId: string;
  status: ComputerUseSessionStatus;
  active: boolean;
  title: string | null;
  url: string | null;
  pendingQuestion: string | null;
  updatedAt: string;
};

type ComputerUseConfig = {
  model: string;
  maxSteps: number;
  reasoningEffort: string;
  headless: boolean;
  viewport: {
    width: number;
    height: number;
  };
};

type PendingQuestion = {
  callId: string;
  question: string;
};

type BrowserSession = {
  sessionId: string;
  context: BrowserContext;
  page: Page;
  vmContext: vm.Context;
  toolOutput: Array<Record<string, unknown>>;
  previousResponseId?: string;
  pendingQuestion?: PendingQuestion;
  status: ComputerUseSessionStatus;
  updatedAt: string;
};

type RunComputerTaskInput = {
  sessionId?: string;
  task: string;
  maxSteps?: number;
};

type ResumeComputerTaskInput = {
  sessionId?: string;
  answer: string;
  maxSteps?: number;
};

type RunLoopInput = {
  session: BrowserSession;
  inputs: unknown[];
  maxSteps: number;
  model: string;
  reasoningEffort: string;
};

type OpenAIResponseItem = {
  type?: string;
  id?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  content?: Array<{ text?: string }>;
  phase?: string | null;
};

type OpenAIResponse = {
  id?: string;
  output?: OpenAIResponseItem[];
};

export class ComputerService {
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly locks = new Map<string, Promise<void>>();

  async runTask(input: RunComputerTaskInput): Promise<ComputerUseRunResult> {
    const config = this.getConfig();
    const sessionId = normalizeSessionId(input.sessionId);

    return this.withSessionLock(sessionId, async () => {
      const previous = this.sessions.get(sessionId);
      if (previous) {
        await this.disposeSession(previous);
      }

      const session = await this.createSession(sessionId, config);
      session.status = "running";
      session.previousResponseId = undefined;
      session.pendingQuestion = undefined;

      return this.runLoop({
        session,
        inputs: [{ role: "user", content: input.task }],
        maxSteps: input.maxSteps ?? config.maxSteps,
        model: config.model,
        reasoningEffort: config.reasoningEffort
      });
    });
  }

  async resumeTask(input: ResumeComputerTaskInput): Promise<ComputerUseRunResult> {
    const config = this.getConfig();
    const sessionId = normalizeSessionId(input.sessionId);

    return this.withSessionLock(sessionId, async () => {
      const session = this.sessions.get(sessionId);
      if (!session) {
        throw new Error(`Computer-use session '${sessionId}' was not found.`);
      }

      if (!session.pendingQuestion) {
        throw new Error(`Computer-use session '${sessionId}' is not waiting for user input.`);
      }

      session.status = "running";
      const pendingQuestion = session.pendingQuestion;
      session.pendingQuestion = undefined;

      return this.runLoop({
        session,
        inputs: [{
          type: "function_call_output",
          call_id: pendingQuestion.callId,
          output: input.answer
        }],
        maxSteps: input.maxSteps ?? config.maxSteps,
        model: config.model,
        reasoningEffort: config.reasoningEffort
      });
    });
  }

  async getSessionSummary(sessionId?: string): Promise<ComputerUseSessionSummary | undefined> {
    const resolvedSessionId = normalizeSessionId(sessionId);
    const session = this.sessions.get(resolvedSessionId);

    if (!session) {
      return undefined;
    }

    return this.buildSessionSummary(session);
  }

  async listSessions(): Promise<ComputerUseSessionSummary[]> {
    return Promise.all([...this.sessions.values()].map(async (session) => this.buildSessionSummary(session)));
  }

  async closeSession(sessionId?: string): Promise<{ sessionId: string; closed: boolean }> {
    const resolvedSessionId = normalizeSessionId(sessionId);

    return this.withSessionLock(resolvedSessionId, async () => {
      const session = this.sessions.get(resolvedSessionId);
      if (!session) {
        return {
          sessionId: resolvedSessionId,
          closed: false
        };
      }

      await this.disposeSession(session);

      return {
        sessionId: resolvedSessionId,
        closed: true
      };
    });
  }

  private async runLoop(input: RunLoopInput): Promise<ComputerUseRunResult> {
    const client = this.createClient();
    const messages: ComputerUseMessage[] = [];
    let previousResponseId = input.session.previousResponseId;
    let pendingInputs = input.inputs;

    for (let step = 0; step < input.maxSteps; step += 1) {
      const response = await client.responses.create({
        model: input.model,
        instructions: [
          "You are operating a persistent Playwright browser session for the user.",
          "Use short JavaScript snippets through exec_js.",
          "Inspect the page state directly, verify outcomes, and do not guess.",
          "Use display(...) or snapshot(...) when a visual check is useful.",
          "Ask the user a question with ask_user only when the task is blocked on missing human input.",
          `The shared browser profile is stored at ${BROWSER_PROFILE_PATH}.`
        ].join(" "),
        input: pendingInputs as never,
        previous_response_id: previousResponseId,
        parallel_tool_calls: false,
        reasoning: {
          effort: input.reasoningEffort as "low" | "medium" | "high"
        },
        tools: [
          {
            type: "function",
            name: "exec_js",
            description: "Execute provided interactive JavaScript in a persistent REPL context.",
            strict: true,
            parameters: {
              type: "object",
              properties: {
                code: {
                  type: "string",
                  description: [
                    "JavaScript to execute in a persistent async REPL with Playwright access.",
                    "Use small snippets, inspect the DOM or page state directly, and verify results instead of guessing.",
                    "Available bindings: browser, context, page, console.log(...), display(base64Png), snapshot(label?).",
                    "Persist cross-call helpers on globalThis if needed.",
                    "Keep screenshots in memory and send them through display().",
                    "Do not access host env vars, secrets, or local files unless the user explicitly asked for it."
                  ].join(" ")
                }
              },
              required: ["code"],
              additionalProperties: false
            }
          },
          {
            type: "function",
            name: "ask_user",
            description: "Ask the user a clarification question when blocked on missing human input.",
            strict: true,
            parameters: {
              type: "object",
              properties: {
                question: {
                  type: "string",
                  description: "The exact clarification question to show the user."
                }
              },
              required: ["question"],
              additionalProperties: false
            }
          }
        ]
      }) as unknown as OpenAIResponse;

      previousResponseId = response.id;
      input.session.previousResponseId = previousResponseId;
      input.session.updatedAt = new Date().toISOString();

      const output = response.output ?? [];
      let latestPhase: string | null = null;
      let nextInputs: unknown[] = [];
      let hadToolCall = false;

      for (const item of output) {
        if (item.type === "function_call" && item.name === "exec_js") {
          hadToolCall = true;
          nextInputs.push({
            type: "function_call_output",
            call_id: item.call_id,
            output: await this.executeJavaScript(input.session, item.arguments ?? "")
          });
          continue;
        }

        if (item.type === "function_call" && item.name === "ask_user") {
          hadToolCall = true;
          const question = getJsonStringField(item.arguments, "question") ?? "Please provide more information.";
          input.session.pendingQuestion = {
            callId: item.call_id ?? "",
            question
          };
          input.session.status = "awaiting_user";

          return {
            ...(await this.buildResultBase(input.session, messages)),
            status: "awaiting_user",
            question,
            steps: step + 1
          };
        }

        if (item.type === "message") {
          const text = extractMessageText(item);
          if (text !== "") {
            messages.push({
              phase: item.phase === "commentary" || item.phase === "final_answer" ? item.phase : "message",
              text
            });
          }
        }

        if (item.phase) {
          latestPhase = item.phase;
        }
      }

      if (!hadToolCall && latestPhase === "final_answer") {
        input.session.status = "completed";
        return {
          ...(await this.buildResultBase(input.session, messages)),
          status: "completed",
          answer: selectFinalAnswer(messages),
          steps: step + 1
        };
      }

      pendingInputs = nextInputs;
    }

    input.session.status = "completed";
    return {
      ...(await this.buildResultBase(input.session, messages)),
      status: "completed",
      answer: selectFinalAnswer(messages) || "Computer-use run stopped after reaching the configured step limit.",
      steps: input.maxSteps
    };
  }

  private async createSession(sessionId: string, config: ComputerUseConfig): Promise<BrowserSession> {
    await mkdir(BROWSER_PROFILE_PATH, { recursive: true });
    await mkdir(BROWSER_ARTIFACTS_PATH, { recursive: true });

    const context = await chromium.launchPersistentContext(BROWSER_PROFILE_PATH, {
      headless: config.headless,
      chromiumSandbox: true,
      viewport: config.viewport,
      env: {},
      args: [
        `--window-size=${config.viewport.width},${config.viewport.height}`,
        "--disable-extensions"
      ]
    });
    const page = context.pages()[0] ?? await context.newPage();
    const toolOutput: Array<Record<string, unknown>> = [];

    const sandbox: Record<string, unknown> = {
      browser: context.browser(),
      context,
      page,
      console: {
        log: (...values: unknown[]) => {
          toolOutput.push({
            type: "input_text",
            text: util.formatWithOptions(
              { showHidden: false, getters: false, maxStringLength: 2000 },
              ...values
            )
          });
        }
      },
      display: (base64Image: string) => {
        toolOutput.push({
          type: "input_image",
          image_url: `data:image/png;base64,${base64Image}`,
          detail: "original"
        });
      },
      snapshot: async (label?: string) => {
        const image = await page.screenshot({ type: "png" });
        const base64 = image.toString("base64");
        toolOutput.push({
          type: "input_image",
          image_url: `data:image/png;base64,${base64}`,
          detail: "original"
        });

        const targetPath = path.join(
          BROWSER_ARTIFACTS_PATH,
          `${sessionId}-${sanitizeLabel(label ?? "snapshot")}-${Date.now()}.png`
        );
        await writeFile(targetPath, image);
        return targetPath;
      }
    };

    const session: BrowserSession = {
      sessionId,
      context,
      page,
      vmContext: vm.createContext(sandbox),
      toolOutput,
      status: "idle",
      updatedAt: new Date().toISOString()
    };

    this.sessions.set(sessionId, session);
    return session;
  }

  private async executeJavaScript(session: BrowserSession, rawArguments: string): Promise<unknown> {
    const code = getJsonStringField(rawArguments, "code") ?? "";
    if (code.length > MAX_CODE_LENGTH) {
      return [{ type: "input_text", text: `Code snippet too large (${code.length} chars). Keep snippets short.` }];
    }

    const wrappedCode = `
      (async () => {
        ${code}
      })();
    `;

    try {
      await new vm.Script(wrappedCode, {
        filename: `${session.sessionId}-exec_js.js`
      }).runInContext(session.vmContext);
    } catch (error) {
      session.toolOutput.push({
        type: "input_text",
        text: formatError(error)
      });
    }

    const output = session.toolOutput.slice();
    session.toolOutput.length = 0;
    return output.length > 0 ? output : "[no output]";
  }

  private async disposeSession(session: BrowserSession): Promise<void> {
    this.sessions.delete(session.sessionId);
    try {
      await session.context.close();
    } catch (error) {
      logger.warn(`Failed to close browser session '${session.sessionId}': ${formatError(error)}`);
    }
  }

  private async buildSessionSummary(session: BrowserSession): Promise<ComputerUseSessionSummary> {
    return {
      sessionId: session.sessionId,
      status: session.status,
      active: !session.page.isClosed(),
      title: await readPageTitle(session.page),
      url: readPageUrl(session.page),
      pendingQuestion: session.pendingQuestion?.question ?? null,
      updatedAt: session.updatedAt
    };
  }

  private async buildResultBase(session: BrowserSession, messages: ComputerUseMessage[]): Promise<ComputerUseBaseResult> {
    return {
      sessionId: session.sessionId,
      title: await readPageTitle(session.page),
      url: readPageUrl(session.page),
      messages
    };
  }

  private createClient(): OpenAI {
    const config = loadConfig();
    const provider = config.providers.find((entry) => entry.name === "openai");

    if (!provider) {
      throw new Error("Computer use requires an 'openai' provider in config.");
    }

    return new OpenAI({ apiKey: provider.apiKey });
  }

  private getConfig(): ComputerUseConfig {
    const config = loadConfig();
    const model = config.computerUse?.model ?? DEFAULT_MODEL;
    const parsedModel = parseModel(model);

    if (parsedModel.provider !== "openai") {
      throw new Error("Computer use only supports models from the 'openai' provider.");
    }

    return {
      model: parsedModel.modelId,
      maxSteps: config.computerUse?.maxSteps ?? DEFAULT_MAX_STEPS,
      reasoningEffort: config.computerUse?.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
      headless: config.computerUse?.headless ?? true,
      viewport: {
        width: config.computerUse?.viewport?.width ?? DEFAULT_VIEWPORT.width,
        height: config.computerUse?.viewport?.height ?? DEFAULT_VIEWPORT.height
      }
    };
  }

  private async withSessionLock<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });

    this.locks.set(sessionId, previous.then(() => current));
    await previous;

    try {
      return await action();
    } finally {
      release();
      if (this.locks.get(sessionId) === current) {
        this.locks.delete(sessionId);
      }
    }
  }
}

export const computerService = new ComputerService();

function extractMessageText(item: OpenAIResponseItem): string {
  const content = item.content ?? [];
  const parts = content
    .map((entry) => entry.text?.trim() ?? "")
    .filter((text) => text !== "");

  return parts.join("\n");
}

function selectFinalAnswer(messages: ComputerUseMessage[]): string {
  const finalAnswers = messages
    .filter((message) => message.phase === "final_answer")
    .map((message) => message.text.trim())
    .filter(Boolean);

  if (finalAnswers.length > 0) {
    return finalAnswers.at(-1) ?? "";
  }

  const allMessages = messages
    .map((message) => message.text.trim())
    .filter(Boolean);

  return allMessages.at(-1) ?? "";
}

function getJsonStringField(value: string | undefined, key: string): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const field = parsed[key];
    return typeof field === "string" ? field : undefined;
  } catch {
    return undefined;
  }
}

function normalizeSessionId(value?: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return `${DEFAULT_SESSION_PREFIX}-default`;
  }

  return trimmed.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function sanitizeLabel(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "snapshot";
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return [error.name, error.message, error.stack].filter(Boolean).join("\n");
  }

  return String(error);
}

function readPageUrl(page: Page): string | null {
  return page.isClosed() ? null : page.url() || null;
}

async function readPageTitle(page: Page): Promise<string | null> {
  if (page.isClosed()) {
    return null;
  }

  try {
    return await page.title();
  } catch {
    return null;
  }
}
