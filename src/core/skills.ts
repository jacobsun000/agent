import path from "path";
import { homedir } from "os";
import { readFile, readdir } from "fs/promises";

import { WORKSPACE_PATH, escapeXml, pathExists } from "@/utils/utils";


const SKILL_DISCOVERY_PATH = [
  path.join(homedir(), ".agents", "skills"),
  path.join(WORKSPACE_PATH, "skills")
];
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

export async function buildSkills(): Promise<string> {
  const skills = await discoverSkills();

  if (skills.length === 0) return "";

  return [
    renderSkillCatalog(skills)
  ].join("\n");
}

async function discoverSkills(): Promise<SkillDefinition[]> {
  const discovered = new Map<string, SkillDefinition>();

  for (const path of SKILL_DISCOVERY_PATH) {
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
