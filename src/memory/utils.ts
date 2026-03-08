import { createHash, randomUUID } from "node:crypto";

import {
  type ConversationMessage,
  type MemoryCategorySeed,
  type MemoryScope,
  type MemoryWhere
} from "@/memory/types";

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "has",
  "have",
  "he",
  "i",
  "in",
  "is",
  "it",
  "its",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "she",
  "that",
  "the",
  "their",
  "them",
  "there",
  "they",
  "this",
  "to",
  "us",
  "was",
  "we",
  "were",
  "with",
  "you",
  "your"
]);

export const DEFAULT_MEMORY_CATEGORIES: MemoryCategorySeed[] = [
  { name: "personal_info", description: "Personal information about the user" },
  { name: "preferences", description: "User preferences, likes and dislikes" },
  { name: "relationships", description: "Information about relationships with others" },
  { name: "activities", description: "Activities, hobbies, and interests" },
  { name: "goals", description: "Goals, aspirations, and objectives" },
  { name: "experiences", description: "Past experiences and events" },
  { name: "knowledge", description: "Knowledge, facts, and learned information" },
  { name: "opinions", description: "Opinions, viewpoints, and perspectives" },
  { name: "habits", description: "Habits, routines, and patterns" },
  { name: "work_life", description: "Work-related information and professional life" }
];

export function nowIso(): string {
  return new Date().toISOString();
}

export function createId(): string {
  return randomUUID();
}

export function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function contentHash(value: string): string {
  return createHash("sha256").update(normalizeText(value)).digest("hex").slice(0, 16);
}

export function tokenize(value: string): string[] {
  const normalized = normalizeText(value).replace(/[^a-z0-9\s]/g, " ");
  const tokens = normalized
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
  return Array.from(new Set(tokens));
}

export function summarizeText(value: string, maxLength = 180): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function cosineSimilarity(left: number[] | null, right: number[] | null): number {
  if (!left || !right || left.length === 0 || right.length === 0 || left.length !== right.length) {
    return 0;
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

export function sentenceSplit(value: string): string[] {
  return value
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((part) => part.trim())
    .filter(Boolean);
}

export function scopeMatches(scope: MemoryScope, where: MemoryWhere | undefined): boolean {
  if (!where) {
    return true;
  }

  return Object.entries(where).every(([rawKey, expected]) => {
    const [key, operator] = rawKey.split("__", 2) as [string, string | undefined];
    const actual = scope[key];

    if (operator === "in") {
      return Array.isArray(expected) ? expected.includes(actual as never) : actual === expected;
    }

    return actual === expected;
  });
}

export function mergeScope(defaultScope: MemoryScope, scope?: MemoryScope): MemoryScope {
  return {
    ...defaultScope,
    ...(scope ?? {})
  };
}

export function stableScopeKey(scope: MemoryScope): string {
  return JSON.stringify(
    Object.entries(scope).sort(([left], [right]) => left.localeCompare(right))
  );
}

export function formatConversation(messages: ConversationMessage[]): string {
  return messages
    .map((message) => `${message.role.toUpperCase()}: ${message.content.trim()}`)
    .join("\n");
}

export function extractPlainTextFromModelContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object") {
        return [];
      }

      const candidate = part as { type?: unknown; text?: unknown };
      if (candidate.type === "text" && typeof candidate.text === "string") {
        return [candidate.text];
      }

      return [];
    })
    .join("\n");
}
