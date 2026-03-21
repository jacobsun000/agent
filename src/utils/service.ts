import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { escapeXml, pathExists } from "@/utils/utils";

const execFileAsync = promisify(execFile);

const SERVICE_NAME = "agent-gateway";
const LAUNCHD_LABEL = "com.agent.gateway";

type ServiceManager = "launchd" | "systemd";

export type GatewayServiceStatus = {
  manager: ServiceManager;
  installed: boolean;
  enabled: boolean;
  running: boolean;
  definitionPath: string;
};

type CommandFailure = Error & {
  code?: number;
  stdout?: string;
  stderr?: string;
};

function getServiceManager(): ServiceManager {
  if (process.platform === "darwin") {
    return "launchd";
  }

  if (process.platform === "linux") {
    return "systemd";
  }

  throw new Error(`Unsupported platform: ${process.platform}. Only macOS and Linux are supported.`);
}

function getLaunchdDefinitionPath(): string {
  return path.join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

function getSystemdDefinitionPath(): string {
  return path.join(homedir(), ".config", "systemd", "user", `${SERVICE_NAME}.service`);
}

function getDefinitionPath(manager: ServiceManager): string {
  return manager === "launchd" ? getLaunchdDefinitionPath() : getSystemdDefinitionPath();
}

function quoteSystemdArgument(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("%", "%%")}"`;
}

function isFailure(error: unknown): error is CommandFailure {
  return error instanceof Error;
}

async function runCommand(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(command, args, {
    encoding: "utf8"
  });

  return {
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim()
  };
}

async function tryRunCommand(command: string, args: string[]): Promise<{ ok: true; stdout: string; stderr: string } | { ok: false; code?: number; stdout: string; stderr: string }> {
  try {
    const result = await runCommand(command, args);
    return { ok: true, ...result };
  } catch (error) {
    if (!isFailure(error)) {
      throw error;
    }

    return {
      ok: false,
      code: error.code,
      stdout: error.stdout?.trim() ?? "",
      stderr: error.stderr?.trim() ?? error.message
    };
  }
}

function getGatewayRuntimePaths(repoRoot: string) {
  const nodePath = process.execPath;
  const tsxCliPath = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const entrypointPath = path.join(repoRoot, "src", "main.ts");

  return {
    nodePath,
    tsxCliPath,
    entrypointPath
  };
}

async function assertGatewayRuntimePaths(repoRoot: string): Promise<void> {
  const { nodePath, tsxCliPath, entrypointPath } = getGatewayRuntimePaths(repoRoot);

  for (const targetPath of [nodePath, tsxCliPath, entrypointPath]) {
    try {
      const targetStat = await stat(targetPath);
      if (!targetStat.isFile()) {
        throw new Error(`${targetPath} is not a file.`);
      }
    } catch {
      throw new Error(`Cannot install gateway service because ${targetPath} is missing.`);
    }
  }
}

function buildLaunchdPlist(repoRoot: string): string {
  const { nodePath, tsxCliPath, entrypointPath } = getGatewayRuntimePaths(repoRoot);
  const logsPath = path.join(homedir(), ".agent", "logs");
  const stdoutPath = path.join(logsPath, "gateway.log");
  const stderrPath = path.join(logsPath, "gateway.error.log");
  const argumentsList = [nodePath, tsxCliPath, entrypointPath, "gateway", "run"];

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(LAUNCHD_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsList.map((value) => `    <string>${escapeXml(value)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(repoRoot)}</string>
  <key>KeepAlive</key>
  <dict>
    <key>Crashed</key>
    <true/>
  </dict>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${escapeXml(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(stderrPath)}</string>
</dict>
</plist>
`;
}

function buildSystemdUnit(repoRoot: string): string {
  const { nodePath, tsxCliPath, entrypointPath } = getGatewayRuntimePaths(repoRoot);
  const execStart = [nodePath, tsxCliPath, entrypointPath, "gateway", "run"]
    .map(quoteSystemdArgument)
    .join(" ");

  return `[Unit]
Description=Agent Gateway
After=network.target

[Service]
Type=simple
WorkingDirectory=${repoRoot}
ExecStart=${execStart}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`;
}

async function writeServiceDefinition(manager: ServiceManager, repoRoot: string): Promise<string> {
  const definitionPath = getDefinitionPath(manager);
  await mkdir(path.dirname(definitionPath), { recursive: true });
  await mkdir(path.join(homedir(), ".agent", "logs"), { recursive: true });

  const contents = manager === "launchd" ? buildLaunchdPlist(repoRoot) : buildSystemdUnit(repoRoot);
  await writeFile(definitionPath, contents, "utf8");

  return definitionPath;
}

function getLaunchdTarget(): string {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error("Cannot determine current user id for launchd.");
  }

  return `gui/${uid}/${LAUNCHD_LABEL}`;
}

async function installLaunchdService(repoRoot: string): Promise<void> {
  const definitionPath = await writeServiceDefinition("launchd", repoRoot);
  const target = getLaunchdTarget();

  await tryRunCommand("launchctl", ["bootout", `gui/${process.getuid?.()}`, definitionPath]);
  await runCommand("launchctl", ["bootstrap", `gui/${process.getuid?.()}`, definitionPath]);
  await runCommand("launchctl", ["enable", target]);
}

async function installSystemdService(repoRoot: string): Promise<void> {
  await writeServiceDefinition("systemd", repoRoot);
  await runCommand("systemctl", ["--user", "daemon-reload"]);
  await runCommand("systemctl", ["--user", "enable", SERVICE_NAME]);
}

export async function installGatewayService(repoRoot: string): Promise<string> {
  await assertGatewayRuntimePaths(repoRoot);

  const manager = getServiceManager();
  const definitionPath = getDefinitionPath(manager);

  if (manager === "launchd") {
    await installLaunchdService(repoRoot);
  } else {
    await installSystemdService(repoRoot);
  }

  return definitionPath;
}

export async function uninstallGatewayService(): Promise<void> {
  const manager = getServiceManager();
  const definitionPath = getDefinitionPath(manager);

  if (manager === "launchd") {
    await tryRunCommand("launchctl", ["bootout", `gui/${process.getuid?.()}`, definitionPath]);
  } else {
    await tryRunCommand("systemctl", ["--user", "disable", "--now", SERVICE_NAME]);
    await tryRunCommand("systemctl", ["--user", "daemon-reload"]);
  }

  if (await pathExists(definitionPath)) {
    await rm(definitionPath);
  }

  if (manager === "systemd") {
    await runCommand("systemctl", ["--user", "daemon-reload"]);
  }
}

export async function startGatewayService(): Promise<void> {
  const manager = getServiceManager();

  if (manager === "launchd") {
    const definitionPath = getDefinitionPath(manager);
    if (!(await pathExists(definitionPath))) {
      throw new Error(`Gateway service is not installed. Run \`agent gateway install\` first.`);
    }

    const domain = `gui/${process.getuid?.()}`;
    const target = getLaunchdTarget();
    await tryRunCommand("launchctl", ["bootstrap", domain, definitionPath]);
    await runCommand("launchctl", ["enable", target]);
    await runCommand("launchctl", ["kickstart", "-k", target]);
    return;
  }

  await runCommand("systemctl", ["--user", "start", SERVICE_NAME]);
}

export async function stopGatewayService(): Promise<void> {
  const manager = getServiceManager();

  if (manager === "launchd") {
    const definitionPath = getDefinitionPath(manager);
    if (!(await pathExists(definitionPath))) {
      throw new Error(`Gateway service is not installed. Run \`agent gateway install\` first.`);
    }

    await tryRunCommand("launchctl", ["bootout", `gui/${process.getuid?.()}`, definitionPath]);
    return;
  }

  await runCommand("systemctl", ["--user", "stop", SERVICE_NAME]);
}

export async function restartGatewayService(): Promise<void> {
  const manager = getServiceManager();

  if (manager === "launchd") {
    await stopGatewayService();
    await startGatewayService();
    return;
  }

  await runCommand("systemctl", ["--user", "restart", SERVICE_NAME]);
}

async function getLaunchdStatus(): Promise<GatewayServiceStatus> {
  const definitionPath = getDefinitionPath("launchd");
  const installed = await pathExists(definitionPath);

  if (!installed) {
    return {
      manager: "launchd",
      installed: false,
      enabled: false,
      running: false,
      definitionPath
    };
  }

  const target = getLaunchdTarget();
  const result = await tryRunCommand("launchctl", ["print", target]);
  const details = `${result.stdout}\n${result.stderr}`;
  const loaded = result.ok;
  const running = loaded && /state = running/.test(details);

  return {
    manager: "launchd",
    installed: true,
    enabled: loaded,
    running,
    definitionPath
  };
}

async function getSystemdStatus(): Promise<GatewayServiceStatus> {
  const definitionPath = getDefinitionPath("systemd");
  const installed = await pathExists(definitionPath);

  if (!installed) {
    return {
      manager: "systemd",
      installed: false,
      enabled: false,
      running: false,
      definitionPath
    };
  }

  const enabledResult = await tryRunCommand("systemctl", ["--user", "is-enabled", SERVICE_NAME]);
  const runningResult = await tryRunCommand("systemctl", ["--user", "is-active", SERVICE_NAME]);

  return {
    manager: "systemd",
    installed: true,
    enabled: enabledResult.ok && enabledResult.stdout === "enabled",
    running: runningResult.ok && runningResult.stdout === "active",
    definitionPath
  };
}

export async function getGatewayServiceStatus(): Promise<GatewayServiceStatus> {
  return getServiceManager() === "launchd" ? getLaunchdStatus() : getSystemdStatus();
}

export async function readGatewayServiceDefinition(): Promise<string | null> {
  const definitionPath = getDefinitionPath(getServiceManager());
  if (!(await pathExists(definitionPath))) {
    return null;
  }

  return readFile(definitionPath, "utf8");
}
