import { readFile, readdir } from "fs/promises";
import { homedir, platform } from "os";
import path from "path";

import { CONFIG_PATH, escapeXml, pathExists } from "@/utils/utils";

const WORKSPACE_PATH = `${CONFIG_PATH}/workspace`;
const MAX_SKILL_SCAN_DEPTH = 6;
const MAX_SCANNED_DIRECTORIES = 2_000;
const SKILL_FILE_NAME = "SKILL.md";
const SKIP_DIRECTORY_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
]);

type SkillDefinition = {
  description: string;
  location: string;
  name: string;
};

type PromptMode = "main" | "sub_agent" | "heartbeat";

// TODO: Dynamically load agent prompt from file so it's editable by users
const MAIN_AGENT_PROMPT = `
# Agent
You are a personal assistant agent running in a local CLI environment.

## Environment
- Workspace: ${WORKSPACE_PATH}
- Current directory: ${process.cwd()}
- Platform: ${platform()}
- Home directory: ${homedir()}

## Tool usage
You may use the exec tool (basically bash) with cli tools like (head, tail, grep, ls, awk, sed, etc) to interact with the computer and files.

## Safety
- Don't exfiltrate private data. Ever.
- Don't run destructive commands without asking.
- \`trash\` > \`rm\` (recoverable beats gone forever)
- When in doubt, ask.
`.trim();

const SUB_AGENT_PROMPT = `
# Sub-Agent
You are a background sub-agent running in a local CLI environment.

## Role
- You were delegated a task by another agent.
- Your final response goes back to the main agent, not directly to the end user.
- Try to complete the entire delegated task in one pass.
- Prefer delivering a concrete result over asking follow-up questions.
- Include concise caveats only when they materially affect the result.

## Environment
- Workspace: ${WORKSPACE_PATH}
- Current directory: ${process.cwd()}
- Platform: ${platform()}
- Home directory: ${homedir()}

## Tool usage
You may use the exec tool (basically bash) with cli tools like (head, tail, grep, ls, awk, sed, etc) to interact with the computer and files.

## Safety
- Don't exfiltrate private data. Ever.
- Don't run destructive commands without asking.
- \`trash\` > \`rm\` (recoverable beats gone forever)
- If blocked, say exactly why.
`.trim();

const HEARTBEAT_PROMPT = `
# Heartbeat Agent
You are a lightweight heartbeat evaluator running in a local CLI environment.

## Role
- You only inspect ${WORKSPACE_PATH}/HEARTBEAT.md content passed into the turn.
- Your job is to decide whether the Active Tasks section contains actionable work.
- If there is no actionable work, respond with exactly \`noop\`.
- If there is actionable work, use the \`sub_agent\` tool to delegate it.
- Keep your own response minimal after delegation.

## Delegation
- The delegated task should include the task description and any relevant context from the HEARTBEAT.md.
- You may spawn multiple sub-agents if there are multiple unrelated tasks, but try to batch related tasks together.
- Use a clear label related to heartbeat work.
- Do not try to complete the tasks yourself.
`.trim();

const MEMORY_PROMPT = (memory: string) => `
## Memory
You wake up fresh each session. These files are your continuity:

- **Long-term:** \`<workspace>/memory/MEMORY.md\` — your curated memories, like a human's long-term memory.
- **Notes:** \`<workspace>/memory/notes/<thing>.md\` - project-specific or topic-specific notes
- **History Log:** \`<workspace>/memory/history/YYYY-MM-DD.md\` — raw logs of what happened

Capture what matters. Decisions, context, things to remember. Organize memory files in a way that makes sense to you.

### MEMORY.md - Your Long-Term Memory
- You can **read, edit, and update** MEMORY.md freely
- This is your curated memory — the distilled essence, not raw logs
- Only keep core memories here, keep this file concise and high-level
- You can reference other note memories in MEMORY.md for details

<contents in MEMORY.md retrieved for you>
${memory}
</contents>

### Notes Memory
- Notes are for specific projects, topics, or areas of knowledge
- Keep what's relevant to that subject here, like a wiki or project journal
- Organize notes in a way that makes sense to you — by project, topic, or however you like

### History Log
- History log is grep-searchable. Each entry starts with [YYYY-MM-DD HH:MM]
- Logs are updated automatically in real-time, you don't need to manage them

### Tips
- Memory is limited, if you want to remember something, WRITE IT TO A FILE.
- Over time, review your memories and update memory files with what's worth keeping
- Mental notes don't survive session restarts. Files do.
`.trim();

const SKILL_PROMPT = (skills: string) => `
## Skills
The following skills extend your capabilities. To use a skill, read its SKILL.md file using the bash tool.

${skills}
`.trim();

export async function getSystemPrompt(mode: PromptMode = "main"): Promise<string> {
  const memoryPath = `${CONFIG_PATH}/workspace/memory/MEMORY.md`;
  const basePrompt =
    mode === "sub_agent" ? SUB_AGENT_PROMPT
      : mode === "heartbeat" ? HEARTBEAT_PROMPT
        : MAIN_AGENT_PROMPT;

  if (mode === "heartbeat") {
    return basePrompt;
  }

  const [memory, skills] = await Promise.all([
    readFile(memoryPath, { encoding: "utf-8" }),
    buildSkills()
  ]);
  return [basePrompt, MEMORY_PROMPT(memory), SKILL_PROMPT(skills)].join("\n\n");
}

async function buildSkills(): Promise<string> {
  const skills = await discoverSkills();

  if (skills.length === 0) {
    return "";
  }

  return [
    renderSkillCatalog(skills)
  ].join("\n");
}

async function discoverSkills(): Promise<SkillDefinition[]> {
  const paths = [
    path.join(homedir(), ".agents", "skills"),
    path.join(WORKSPACE_PATH, "skills")
  ];
  const discovered = new Map<string, SkillDefinition>();

  for (const path of paths) {
    if (!(await pathExists(path))) {
      continue;
    }

    const skillFilePaths = await findSkillFiles(path);

    for (const skillFilePath of skillFilePaths) {
      const skill = await loadSkillDefinition(skillFilePath);
      if (!skill) {
        continue;
      }

      discovered.set(skill.name, skill);
    }
  }

  return [...discovered.values()].sort((left, right) => left.name.localeCompare(right.name));
}

async function findSkillFiles(rootPath: string): Promise<string[]> {
  const skillFiles: string[] = [];
  let scannedDirectories = 0;

  async function visit(directoryPath: string, depth: number): Promise<void> {
    if (depth > MAX_SKILL_SCAN_DEPTH || scannedDirectories >= MAX_SCANNED_DIRECTORIES) {
      return;
    }

    scannedDirectories += 1;

    let entries;
    try {
      entries = await readdir(directoryPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORY_NAMES.has(entry.name)) {
          continue;
        }

        await visit(path.join(directoryPath, entry.name), depth + 1);
        continue;
      }

      if (entry.isFile() && entry.name === SKILL_FILE_NAME) {
        skillFiles.push(path.join(directoryPath, entry.name));
      }
    }
  }

  await visit(rootPath, 0);
  return skillFiles;
}

async function loadSkillDefinition(skillFilePath: string): Promise<SkillDefinition | undefined> {
  let content: string;

  try {
    content = await readFile(skillFilePath, "utf8");
  } catch {
    return undefined;
  }

  const metadata = parseSkillMetadata(content);
  const fallbackName = path.basename(path.dirname(skillFilePath));
  const name = sanitizeSkillField(metadata.name) ?? fallbackName;
  const description = sanitizeSkillField(metadata.description) ?? extractDescriptionFallback(content);

  if (!name || !description) {
    return undefined;
  }

  return {
    name,
    description,
    location: skillFilePath
  };
}

function parseSkillMetadata(content: string): { description?: string; name?: string } {
  if (!content.startsWith("---")) {
    return {};
  }

  const normalized = content.replace(/\r\n/g, "\n");
  const endIndex = normalized.indexOf("\n---", 3);

  if (endIndex === -1) {
    return {};
  }

  const frontmatter = normalized.slice(4, endIndex).split("\n");
  const metadata: { description?: string; name?: string } = {};

  for (const line of frontmatter) {
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.+?)\s*$/.exec(line);
    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;
    if (key !== "name" && key !== "description") {
      continue;
    }

    const value = stripQuotes(rawValue.trim());
    if (value.length === 0) {
      continue;
    }

    metadata[key] = value;
  }

  return metadata;
}

function extractDescriptionFallback(content: string): string | undefined {
  const withoutFrontmatter = content.startsWith("---")
    ? content.replace(/^---[\s\S]*?\n---\n?/, "")
    : content;
  const lines = withoutFrontmatter
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (line.startsWith("#")) {
      continue;
    }

    return line.length > 240 ? `${line.slice(0, 237)}...` : line;
  }

  return undefined;
}

function renderSkillCatalog(skills: SkillDefinition[]): string {
  const items = skills.map((skill) => [
    "  <skill>",
    `    <name>${escapeXml(skill.name)}</name>`,
    `    <description>${escapeXml(skill.description)}</description>`,
    `    <location>${escapeXml(skill.location)}</location>`,
    "  </skill>"
  ].join("\n"));

  return [
    "<available_skills>",
    ...items,
    "</available_skills>"
  ].join("\n");
}

function sanitizeSkillField(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).trim();
  }
  return value;
}
