import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type CommandFailure = Error & {
  code?: number;
  stdout?: string;
  stderr?: string;
};

export type GatewayUpdateOptions = {
  repoRoot: string;
  remote: string;
  branch?: string;
  installDependencies: boolean;
};

export type GatewayUpdateStatus =
  | "up_to_date"
  | "update_available"
  | "updated"
  | "dirty"
  | "ahead"
  | "diverged";

export type GatewayUpdateResult = {
  status: GatewayUpdateStatus;
  repoRoot: string;
  remote: string;
  branch: string;
  trackingRef: string;
  currentCommit: string;
  targetCommit: string;
  localAheadCount: number;
  remoteAheadCount: number;
  changedFiles: string[];
  dependencyInstallRan: boolean;
  applied: boolean;
  summary: string;
};

function isFailure(error: unknown): error is CommandFailure {
  return error instanceof Error;
}

async function runCommand(
  cwd: string,
  command: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(command, args, {
    cwd,
    encoding: "utf8"
  });

  return {
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim()
  };
}

async function ensureGitRepository(repoRoot: string): Promise<void> {
  const result = await runCommand(repoRoot, "git", ["rev-parse", "--is-inside-work-tree"]);
  if (result.stdout !== "true") {
    throw new Error(`${repoRoot} is not a git repository.`);
  }
}

async function getCurrentBranch(repoRoot: string): Promise<string> {
  const result = await runCommand(repoRoot, "git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = result.stdout.trim();
  if (branch === "" || branch === "HEAD") {
    throw new Error("Cannot auto-update from a detached HEAD. Configure updater.branch or check out a branch.");
  }

  return branch;
}

async function getCommit(repoRoot: string, ref: string): Promise<string> {
  const result = await runCommand(repoRoot, "git", ["rev-parse", ref]);
  return result.stdout.trim();
}

async function getAheadBehind(repoRoot: string, trackingRef: string): Promise<{ localAheadCount: number; remoteAheadCount: number }> {
  const result = await runCommand(repoRoot, "git", ["rev-list", "--left-right", "--count", `HEAD...${trackingRef}`]);
  const [localAheadRaw, remoteAheadRaw] = result.stdout.trim().split(/\s+/);
  const localAheadCount = Number(localAheadRaw ?? "0");
  const remoteAheadCount = Number(remoteAheadRaw ?? "0");

  return {
    localAheadCount,
    remoteAheadCount
  };
}

async function getChangedFiles(repoRoot: string, fromRef: string, toRef: string): Promise<string[]> {
  const result = await runCommand(repoRoot, "git", [
    "diff",
    "--name-only",
    fromRef,
    toRef,
    "--",
    "package.json",
    "pnpm-lock.yaml"
  ]);

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

async function hasDirtyWorktree(repoRoot: string): Promise<boolean> {
  const result = await runCommand(repoRoot, "git", ["status", "--porcelain"]);
  return result.stdout !== "";
}

function createResult(
  input: Omit<GatewayUpdateResult, "changedFiles" | "dependencyInstallRan" | "applied"> & {
    changedFiles?: string[];
    dependencyInstallRan?: boolean;
    applied?: boolean;
  }
): GatewayUpdateResult {
  return {
    changedFiles: input.changedFiles ?? [],
    dependencyInstallRan: input.dependencyInstallRan ?? false,
    applied: input.applied ?? false,
    ...input
  };
}

async function inspectRemoteState(options: GatewayUpdateOptions): Promise<GatewayUpdateResult> {
  await ensureGitRepository(options.repoRoot);
  await runCommand(options.repoRoot, "git", ["fetch", "--prune", options.remote]);

  const branch = options.branch ?? await getCurrentBranch(options.repoRoot);
  const trackingRef = `${options.remote}/${branch}`;
  const currentCommit = await getCommit(options.repoRoot, "HEAD");
  const targetCommit = await getCommit(options.repoRoot, trackingRef);
  const dirty = await hasDirtyWorktree(options.repoRoot);
  const { localAheadCount, remoteAheadCount } = await getAheadBehind(options.repoRoot, trackingRef);

  if (dirty) {
    return createResult({
      status: "dirty",
      repoRoot: options.repoRoot,
      remote: options.remote,
      branch,
      trackingRef,
      currentCommit,
      targetCommit,
      localAheadCount,
      remoteAheadCount,
      summary: "Skipped update because the git worktree has local changes."
    });
  }

  if (localAheadCount > 0 && remoteAheadCount > 0) {
    return createResult({
      status: "diverged",
      repoRoot: options.repoRoot,
      remote: options.remote,
      branch,
      trackingRef,
      currentCommit,
      targetCommit,
      localAheadCount,
      remoteAheadCount,
      summary: `Skipped update because local ${branch} has diverged from ${trackingRef}.`
    });
  }

  if (localAheadCount > 0) {
    return createResult({
      status: "ahead",
      repoRoot: options.repoRoot,
      remote: options.remote,
      branch,
      trackingRef,
      currentCommit,
      targetCommit,
      localAheadCount,
      remoteAheadCount,
      summary: `Skipped update because local ${branch} is ahead of ${trackingRef}.`
    });
  }

  if (remoteAheadCount === 0) {
    return createResult({
      status: "up_to_date",
      repoRoot: options.repoRoot,
      remote: options.remote,
      branch,
      trackingRef,
      currentCommit,
      targetCommit,
      localAheadCount,
      remoteAheadCount,
      summary: `Already up to date with ${trackingRef}.`
    });
  }

  return createResult({
    status: "update_available",
    repoRoot: options.repoRoot,
    remote: options.remote,
    branch,
    trackingRef,
    currentCommit,
    targetCommit,
    localAheadCount,
    remoteAheadCount,
    summary: `Update available from ${trackingRef}.`
  });
}

async function installDependencies(repoRoot: string): Promise<void> {
  await runCommand(repoRoot, "pnpm", ["install", "--frozen-lockfile"]);
}

export async function checkGatewayUpdate(options: GatewayUpdateOptions): Promise<GatewayUpdateResult> {
  return inspectRemoteState(options);
}

export async function applyGatewayUpdate(options: GatewayUpdateOptions): Promise<GatewayUpdateResult> {
  const inspection = await inspectRemoteState(options);
  if (inspection.status !== "update_available") {
    return inspection;
  }

  await runCommand(options.repoRoot, "git", ["pull", "--ff-only", options.remote, inspection.branch]);
  const changedFiles = await getChangedFiles(options.repoRoot, inspection.currentCommit, inspection.targetCommit);
  let dependencyInstallRan = false;

  if (options.installDependencies && changedFiles.length > 0) {
    await installDependencies(options.repoRoot);
    dependencyInstallRan = true;
  }

  return createResult({
    ...inspection,
    status: "updated",
    currentCommit: inspection.targetCommit,
    changedFiles,
    dependencyInstallRan,
    applied: true,
    summary: `Updated to ${inspection.targetCommit.slice(0, 12)} from ${inspection.trackingRef}.`
  });
}

