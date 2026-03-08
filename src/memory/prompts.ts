import { type MemoryCategorySeed } from "@/memory/types";

export const MEMORY_TYPES = [
  "profile",
  "event",
  "knowledge",
  "behavior",
  "skill",
  "tool"
] as const;

export function buildConsolidationPrompt(input: {
  conversation: string;
  categories: MemoryCategorySeed[];
}): string {
  const categoryLines = input.categories
    .map((category) => `- ${category.name}: ${category.description}`)
    .join("\n");

  return `
You are extracting long-term memory from an agent conversation.

Return durable, reusable memory only. Do not keep filler, greetings, or short-lived coordination unless it reveals a stable preference, project, plan, task, fact, workflow, tool usage pattern, or recurring behavior.

Allowed memory types:
- profile
- event
- knowledge
- behavior
- skill
- tool

Allowed categories:
${categoryLines}

Requirements:
- Produce a short caption summarizing the whole conversation chunk.
- Produce atomic memory items.
- Each item must have:
  - memoryType
  - summary
  - evidence
  - categories chosen from the allowed category names
- Keep summaries concise and specific.
- Prefer fewer, higher-quality items over many weak ones.
- If nothing durable should be stored, return an empty items array.

Conversation:
${input.conversation}
`.trim();
}

export function buildCategorySummaryPrompt(input: {
  categoryName: string;
  categoryDescription: string;
  currentSummary: string;
  newItems: string[];
}): string {
  const newItemsText = input.newItems.map((item) => `- ${item}`).join("\n");

  return `
Update the long-term summary for a memory category.

Category: ${input.categoryName}
Description: ${input.categoryDescription}

Current summary:
${input.currentSummary || "No current summary."}

New memory items:
${newItemsText || "- No new memory items."}

Write a concise summary that merges the existing summary with the new items.
Keep it factual, compact, and useful for future retrieval.
Do not use markdown headings or code fences.
`.trim();
}
