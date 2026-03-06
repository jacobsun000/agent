import { spawn } from "node:child_process";
import { tool } from "ai";
import { z } from "zod";

const MAX_OUTPUT_CHARS = 8192;
const DEFAULT_TIMEOUT_MS = 60_000;

type ExecResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export const execTool = tool({
  title: "exec",
  description: "Execute a shell command and return its output. Use with caution.",
  inputSchema: z.object({
    command: z.string().min(1, "Command must not be empty.")
  }),
  async execute({ command }) {
    return executeBash(command);
  }
});

function executeBash(command: string): Promise<ExecResult> {
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
    }, DEFAULT_TIMEOUT_MS);

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

function truncate(value: string): string {
  if (value.length <= MAX_OUTPUT_CHARS) {
    return value;
  }

  return `${value.slice(0, MAX_OUTPUT_CHARS)}\n...[truncated, ${value.length - MAX_OUTPUT_CHARS} more chars]`;
}
