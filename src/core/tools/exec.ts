import { spawn } from "node:child_process";
import { tool } from "ai";
import { z } from "zod";

const MAX_OUTPUT_CHARS = 8192;
const DEFAULT_TIMEOUT_MS = 60_000;
const SUB_AGENT_LLM_CLI_TIMEOUT_MS = 60 * 60 * 1_000;

type ExecToolMode = "main" | "sub_agent" | "heartbeat";

type ExecResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export function createExecTool(mode: ExecToolMode) {
  return tool({
    title: "exec",
    description: "Execute a shell command and return its output. Use with caution.",
    inputSchema: z.object({
      command: z.string().min(1, "Command must not be empty.")
    }),
    async execute({ command }) {
      return executeBash(command, resolveTimeoutMs(mode, command));
    }
  });
}

function executeBash(command: string, timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-lc", command], {
      cwd: process.cwd(),
      env: process.env
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({
        stdout: truncate(stdout) || "[no output]",
        stderr: truncate(stderr),
        exitCode,
        timedOut
      });
    });
  });
}

function resolveTimeoutMs(mode: ExecToolMode, command: string): number {
  if (mode !== "sub_agent") {
    return DEFAULT_TIMEOUT_MS;
  }

  const executable = extractLeadingExecutable(command);
  if (executable === "codex" || executable === "claude") {
    return SUB_AGENT_LLM_CLI_TIMEOUT_MS;
  }

  return DEFAULT_TIMEOUT_MS;
}

function extractLeadingExecutable(command: string): string | null {
  const trimmed = command.trimStart();
  const match = trimmed.match(/^([^\s;&|]+)/);
  if (!match) {
    return null;
  }

  const executable = match[1].split("/").pop();
  return executable ?? null;
}

function truncate(value: string): string {
  if (value.length <= MAX_OUTPUT_CHARS) {
    return value;
  }

  return `${value.slice(0, MAX_OUTPUT_CHARS)}\n...[truncated, ${value.length - MAX_OUTPUT_CHARS} more chars]`;
}
