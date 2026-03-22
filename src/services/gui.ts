import { spawn, execFile as execFileCallback } from "node:child_process";
import { promises as fs, closeSync, openSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { WORKSPACE_PATH } from "@/utils/utils";

const execFile = promisify(execFileCallback);

const GUI_ROOT_PATH = process.env.AGENT_GUI_ROOT?.trim() || path.join(WORKSPACE_PATH, "gui");
const GUI_SESSIONS_PATH = path.join(GUI_ROOT_PATH, "sessions");
const GUI_SCREENSHOTS_PATH = path.join(GUI_ROOT_PATH, "screenshots");
const DEFAULT_SESSION_ID = "default";
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;
const DEFAULT_DEPTH = 24;
const DISPLAY_MIN = 90;
const DISPLAY_MAX = 110;
const READY_RETRIES = 40;
const READY_DELAY_MS = 250;

type GuiSessionRecord = {
  id: string;
  display: string;
  width: number;
  height: number;
  depth: number;
  pid: number;
  startedAt: string;
  logPath: string;
  launchCommand?: string;
  appPid?: number;
  appStartedAt?: string;
};

export type GuiSessionStatus = GuiSessionRecord & {
  active: boolean;
  screenshotDir: string;
  mouse: { x: number; y: number; screen: number; window: number } | null;
};

export type GuiDependencyStatus = {
  Xvfb: boolean;
  xdotool: boolean;
  import: boolean;
  xrandr: boolean;
};

type StartSessionInput = {
  id?: string;
  width?: number;
  height?: number;
  depth?: number;
  command?: string;
};

type ScreenshotInput = {
  id?: string;
  label?: string;
};

type MouseMoveInput = {
  id?: string;
  x: number;
  y: number;
};

type MouseClickInput = {
  id?: string;
  x?: number;
  y?: number;
  button?: "left" | "middle" | "right";
  double?: boolean;
};

type KeyboardTypeInput = {
  id?: string;
  text: string;
  delayMs?: number;
};

type KeyboardKeyInput = {
  id?: string;
  keys: string[];
};

type ScrollInput = {
  id?: string;
  x?: number;
  y?: number;
  scrollX?: number;
  scrollY?: number;
};

type GuiCommandResult = {
  stdout: string;
  stderr: string;
};

export type GuiScreenshotResult = {
  session: GuiSessionStatus;
  path: string;
  mediaType: "image/png";
  data: string;
};

export class GuiService {
  async getDependencyStatus(): Promise<GuiDependencyStatus> {
    const [Xvfb, xdotool, imageImport, xrandr] = await Promise.all([
      commandExists("Xvfb"),
      commandExists("xdotool"),
      commandExists("import"),
      commandExists("xrandr")
    ]);

    return {
      Xvfb,
      xdotool,
      import: imageImport,
      xrandr
    };
  }

  async doctor(): Promise<{
    ok: boolean;
    dependencies: GuiDependencyStatus;
    guiRoot: string;
  }> {
    await ensureGuiDirectories();
    const dependencies = await this.getDependencyStatus();
    const ok = Object.values(dependencies).every(Boolean);

    return {
      ok,
      dependencies,
      guiRoot: GUI_ROOT_PATH
    };
  }

  async startSession(input: StartSessionInput = {}): Promise<GuiSessionStatus> {
    await ensureDependencies(["Xvfb", "xrandr"]);
    await ensureGuiDirectories();

    const id = normalizeSessionId(input.id);
    const existing = await this.getSessionStatus(id);
    if (existing?.active) {
      return existing;
    }

    const width = input.width ?? DEFAULT_WIDTH;
    const height = input.height ?? DEFAULT_HEIGHT;
    const depth = input.depth ?? DEFAULT_DEPTH;
    const displayNumber = await findAvailableDisplayNumber();
    const display = `:${displayNumber}`;
    const logPath = path.join(GUI_ROOT_PATH, `${id}.xvfb.log`);
    const logFd = openSync(logPath, "a");

    const xvfb = spawn("Xvfb", [
      display,
      "-screen",
      "0",
      `${width}x${height}x${depth}`,
      "-nolisten",
      "tcp"
    ], {
      detached: true,
      stdio: ["ignore", logFd, logFd]
    });

    closeSync(logFd);
    xvfb.unref();

    const record: GuiSessionRecord = {
      id,
      display,
      width,
      height,
      depth,
      pid: xvfb.pid ?? 0,
      startedAt: new Date().toISOString(),
      logPath,
      ...(input.command ? { launchCommand: input.command } : {})
    };

    if (!record.pid) {
      throw new Error("Failed to start Xvfb: missing PID.");
    }

    try {
      await waitForDisplayReady(display);
    } catch (error) {
      killIfRunning(record.pid, "SIGTERM");
      await delay(150);
      killIfRunning(record.pid, "SIGKILL");
      const logTail = await readLogTail(logPath);
      const detail = logTail ? `\nXvfb log tail:\n${logTail}` : "";
      throw new Error(`${error instanceof Error ? error.message : String(error)}${detail}`);
    }

    if (input.command) {
      const app = spawn("bash", ["-lc", input.command], {
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          DISPLAY: display
        }
      });
      app.unref();
      record.appPid = app.pid ?? undefined;
      record.appStartedAt = new Date().toISOString();
    }

    await saveSessionRecord(record);
    return this.requireSession(id);
  }

  async stopSession(id?: string): Promise<{ id: string; stopped: boolean }> {
    const sessionId = normalizeSessionId(id);
    const record = await readSessionRecord(sessionId);
    if (!record) {
      return { id: sessionId, stopped: false };
    }

    if (record.appPid) {
      killIfRunning(record.appPid, "SIGTERM");
    }

    killIfRunning(record.pid, "SIGTERM");
    await delay(150);
    killIfRunning(record.pid, "SIGKILL");

    await deleteSessionRecord(sessionId);
    return { id: sessionId, stopped: true };
  }

  async listSessions(): Promise<GuiSessionStatus[]> {
    await ensureGuiDirectories();
    const entries = await fs.readdir(GUI_SESSIONS_PATH);
    const sessions = await Promise.all(entries
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => this.getSessionStatus(path.basename(entry, ".json"))));

    return sessions.filter((session): session is GuiSessionStatus => session !== undefined);
  }

  async getSessionStatus(id?: string): Promise<GuiSessionStatus | undefined> {
    const record = await readSessionRecord(normalizeSessionId(id));
    if (!record) {
      return undefined;
    }

    const active = isPidRunning(record.pid);
    const mouse = active ? await getMouseLocation(record.display) : null;

    return {
      ...record,
      active,
      screenshotDir: path.join(GUI_SCREENSHOTS_PATH, record.id),
      mouse
    };
  }

  async requireSession(id?: string): Promise<GuiSessionStatus> {
    const session = await this.getSessionStatus(id);
    if (!session) {
      throw new Error(`GUI session '${normalizeSessionId(id)}' was not found.`);
    }

    if (!session.active) {
      throw new Error(`GUI session '${session.id}' exists but is not active.`);
    }

    return session;
  }

  async captureScreenshot(input: ScreenshotInput = {}): Promise<GuiScreenshotResult> {
    await ensureDependencies(["import"]);

    const session = await this.requireSession(input.id);
    const screenshotDir = path.join(GUI_SCREENSHOTS_PATH, session.id);
    await fs.mkdir(screenshotDir, { recursive: true });

    const label = sanitizeLabel(input.label);
    const fileName = `${new Date().toISOString().replaceAll(":", "-")}${label ? `-${label}` : ""}.png`;
    const targetPath = path.join(screenshotDir, fileName);

    await execDisplayCommand(session.display, "import", ["-window", "root", targetPath]);
    const data = await fs.readFile(targetPath);

    return {
      session,
      path: targetPath,
      mediaType: "image/png",
      data: data.toString("base64")
    };
  }

  async moveMouse(input: MouseMoveInput): Promise<GuiSessionStatus> {
    await ensureDependencies(["xdotool"]);

    const session = await this.requireSession(input.id);
    await execDisplayCommand(session.display, "xdotool", [
      "mousemove",
      "--sync",
      String(Math.round(input.x)),
      String(Math.round(input.y))
    ]);
    return this.requireSession(session.id);
  }

  async clickMouse(input: MouseClickInput = {}): Promise<GuiSessionStatus> {
    await ensureDependencies(["xdotool"]);

    const session = await this.requireSession(input.id);

    if (typeof input.x === "number" && typeof input.y === "number") {
      await this.moveMouse({
        id: session.id,
        x: input.x,
        y: input.y
      });
    }

    const button = toMouseButton(input.button);
    const repeat = input.double ? "2" : "1";
    await execDisplayCommand(session.display, "xdotool", [
      "click",
      "--repeat",
      repeat,
      button
    ]);

    return this.requireSession(session.id);
  }

  async typeText(input: KeyboardTypeInput): Promise<GuiSessionStatus> {
    await ensureDependencies(["xdotool"]);

    const session = await this.requireSession(input.id);
    await execDisplayCommand(session.display, "xdotool", [
      "type",
      "--clearmodifiers",
      "--delay",
      String(input.delayMs ?? 12),
      input.text
    ]);

    return this.requireSession(session.id);
  }

  async pressKeys(input: KeyboardKeyInput): Promise<GuiSessionStatus> {
    await ensureDependencies(["xdotool"]);

    const session = await this.requireSession(input.id);
    const normalized = input.keys.map(normalizeKeyName);
    await execDisplayCommand(session.display, "xdotool", [
      "key",
      "--clearmodifiers",
      normalized.join("+")
    ]);

    return this.requireSession(session.id);
  }

  async scroll(input: ScrollInput): Promise<GuiSessionStatus> {
    await ensureDependencies(["xdotool"]);

    const session = await this.requireSession(input.id);

    if (typeof input.x === "number" && typeof input.y === "number") {
      await this.moveMouse({
        id: session.id,
        x: input.x,
        y: input.y
      });
    }

    const verticalSteps = toScrollSteps(input.scrollY ?? 0);
    const horizontalSteps = toScrollSteps(input.scrollX ?? 0);

    if (verticalSteps.count > 0) {
      await execDisplayCommand(session.display, "xdotool", [
        "click",
        "--repeat",
        String(verticalSteps.count),
        verticalSteps.direction > 0 ? "5" : "4"
      ]);
    }

    if (horizontalSteps.count > 0) {
      await execDisplayCommand(session.display, "xdotool", [
        "click",
        "--repeat",
        String(horizontalSteps.count),
        horizontalSteps.direction > 0 ? "7" : "6"
      ]);
    }

    return this.requireSession(session.id);
  }

  async runInSession(id: string | undefined, command: string): Promise<{
    session: GuiSessionStatus;
    stdout: string;
    stderr: string;
  }> {
    const session = await this.requireSession(id);
    const result = await execDisplayCommand(session.display, "bash", ["-lc", command]);
    return {
      session,
      ...result
    };
  }
}

async function ensureGuiDirectories(): Promise<void> {
  await fs.mkdir(GUI_ROOT_PATH, { recursive: true });
  await fs.mkdir(GUI_SESSIONS_PATH, { recursive: true });
  await fs.mkdir(GUI_SCREENSHOTS_PATH, { recursive: true });
}

async function saveSessionRecord(record: GuiSessionRecord): Promise<void> {
  await fs.writeFile(
    getSessionRecordPath(record.id),
    JSON.stringify(record, null, 2),
    "utf8"
  );
}

async function readSessionRecord(id: string): Promise<GuiSessionRecord | undefined> {
  try {
    const content = await fs.readFile(getSessionRecordPath(id), "utf8");
    return JSON.parse(content) as GuiSessionRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function deleteSessionRecord(id: string): Promise<void> {
  try {
    await fs.unlink(getSessionRecordPath(id));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function getSessionRecordPath(id: string): string {
  return path.join(GUI_SESSIONS_PATH, `${id}.json`);
}

async function findAvailableDisplayNumber(): Promise<number> {
  for (let display = DISPLAY_MIN; display <= DISPLAY_MAX; display += 1) {
    const lockPath = `/tmp/.X${display}-lock`;
    const socketPath = `/tmp/.X11-unix/X${display}`;

    const [lockExists, socketExists] = await Promise.all([
      pathExists(lockPath),
      pathExists(socketPath)
    ]);

    if (!lockExists && !socketExists) {
      return display;
    }
  }

  throw new Error(`No available X display number found in range ${DISPLAY_MIN}-${DISPLAY_MAX}.`);
}

async function waitForDisplayReady(display: string): Promise<void> {
  for (let attempt = 0; attempt < READY_RETRIES; attempt += 1) {
    try {
      await execDisplayCommand(display, "xrandr", ["--current"]);
      return;
    } catch {
      await delay(READY_DELAY_MS);
    }
  }

  throw new Error(`Timed out waiting for display ${display} to become ready.`);
}

async function execDisplayCommand(display: string, command: string, args: string[]): Promise<GuiCommandResult> {
  const { stdout, stderr } = await execFile(command, args, {
    env: {
      ...process.env,
      DISPLAY: display
    },
    maxBuffer: 8 * 1024 * 1024
  });

  return {
    stdout: stdout.trim(),
    stderr: stderr.trim()
  };
}

async function ensureDependencies(commands: Array<keyof GuiDependencyStatus>): Promise<void> {
  const status = await guiService.getDependencyStatus();
  const missing = commands.filter((command) => !status[command]);

  if (missing.length > 0) {
    throw new Error(`Missing required GUI dependencies: ${missing.join(", ")}.`);
  }
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFile("bash", ["-lc", `command -v ${command}`]);
    return true;
  } catch {
    return false;
  }
}

async function getMouseLocation(display: string): Promise<{ x: number; y: number; screen: number; window: number } | null> {
  try {
    const { stdout } = await execDisplayCommand(display, "xdotool", ["getmouselocation", "--shell"]);
    const values = parseShellAssignment(stdout);

    return {
      x: Number(values.X ?? 0),
      y: Number(values.Y ?? 0),
      screen: Number(values.SCREEN ?? 0),
      window: Number(values.WINDOW ?? 0)
    };
  } catch {
    return null;
  }
}

function parseShellAssignment(value: string): Record<string, string> {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .reduce<Record<string, string>>((accumulator, line) => {
      const [key, ...rest] = line.split("=");
      accumulator[key] = rest.join("=");
      return accumulator;
    }, {});
}

function normalizeSessionId(id?: string): string {
  const value = (id ?? DEFAULT_SESSION_ID).trim();
  if (!/^[a-z0-9_-]+$/i.test(value)) {
    throw new Error("GUI session ID must use only letters, numbers, underscores, or dashes.");
  }
  return value;
}

function sanitizeLabel(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed.replaceAll(/[^a-z0-9_-]+/gi, "-").replaceAll(/^-+|-+$/g, "").toLowerCase();
}

function toMouseButton(value?: "left" | "middle" | "right"): string {
  switch (value ?? "left") {
    case "left":
      return "1";
    case "middle":
      return "2";
    case "right":
      return "3";
  }
}

function toScrollSteps(delta: number): { direction: number; count: number } {
  if (delta === 0) {
    return { direction: 0, count: 0 };
  }

  return {
    direction: Math.sign(delta),
    count: Math.max(1, Math.ceil(Math.abs(delta) / 120))
  };
}

function normalizeKeyName(value: string): string {
  const trimmed = value.trim();
  const normalized = trimmed.toLowerCase();

  switch (normalized) {
    case "ctrl":
    case "control":
      return "ctrl";
    case "alt":
      return "alt";
    case "cmd":
    case "command":
    case "meta":
      return "Super_L";
    case "shift":
      return "shift";
    case "enter":
    case "return":
      return "Return";
    case "esc":
    case "escape":
      return "Escape";
    case "space":
      return "space";
    case "tab":
      return "Tab";
    case "backspace":
      return "BackSpace";
    case "delete":
      return "Delete";
    case "up":
      return "Up";
    case "down":
      return "Down";
    case "left":
      return "Left";
    case "right":
      return "Right";
    case "pageup":
      return "Page_Up";
    case "pagedown":
      return "Page_Down";
    case "home":
      return "Home";
    case "end":
      return "End";
    default:
      return trimmed.length === 1 ? trimmed : trimmed;
  }
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killIfRunning(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code !== "ESRCH") {
      throw error;
    }
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function readLogTail(logPath: string): Promise<string> {
  try {
    const content = await fs.readFile(logPath, "utf8");
    return content.trim().split("\n").slice(-12).join("\n");
  } catch {
    return "";
  }
}

export const guiService = new GuiService();
