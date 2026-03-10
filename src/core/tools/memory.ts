import { tool } from "ai";
import { z } from "zod";

import { type ConversationScope, type MemoryService } from "@/memory";

export function createMemoryRecallTool(memory: MemoryService, scope: ConversationScope) {
  return tool({
    title: "memory_recall",
    description: "Search long-term memory for facts, preferences, plans, or prior context related to the current task.",
    inputSchema: z.object({
      query: z.string().min(1, "Query must not be empty."),
      topK: z.number().int().min(1).max(8).optional()
    }),
    async execute({ query, topK }) {
      const result = await memory.recall({
        scope,
        query,
        topK
      });

      return {
        query: result.query,
        categories: result.categories.map((category) => ({
          name: category.name,
          summary: category.summary,
          score: Number(category.score.toFixed(3))
        })),
        items: result.items.map((item) => ({
          summary: item.summary,
          memoryType: item.memoryType,
          score: Number(item.score.toFixed(3))
        })),
        contextText: result.contextText || "[no relevant memory found]"
      };
    }
  });
}

export function createMemoryRememberTool(memory: MemoryService, scope: ConversationScope) {
  return tool({
    title: "memory_remember",
    description: "Store an important durable note in long-term memory, such as a user preference, standing instruction, workflow, or project fact.",
    inputSchema: z.object({
      note: z.string().min(1, "Note must not be empty."),
      source: z.string().min(1).max(120).optional()
    }),
    async execute({ note, source }) {
      const result = await memory.rememberText({
        scope,
        text: note,
        source: source ?? `tool:${scope.sessionId}:manual-note`,
        metadata: {
          origin: "memory_tool"
        }
      });

      return {
        stored: Boolean(result),
        itemCount: result?.items.length ?? 0,
        categories: result?.categories
          .filter((category) => category.itemCount > 0)
          .map((category) => category.name) ?? []
      };
    }
  });
}
