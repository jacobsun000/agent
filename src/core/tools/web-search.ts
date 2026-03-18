import { tool } from "ai";
import { z } from "zod";
import { TavilyClient } from "@tavily/core";

const webSearchInputSchema = z.object({
  query: z.string().trim().min(1, "Query must not be empty."),
  count: z.number().int().positive().max(10).optional().describe("Number of search results to return (default: 5)"),
});

type WebSearchToolConfig = {
  tavily: TavilyClient;
};

export function createWebSearchTool(config: WebSearchToolConfig) {
  return tool({
    title: "web_search",
    description: "Search web",
    inputSchema: webSearchInputSchema,
    async execute(input) {
      const result = await config.tavily.search(input.query, {
        searchDepth: "basic",
        maxResults: input.count || 5
      });
      return result.results.map((item) => ({
        url: item.url,
        title: item.title,
        content: item.content,
      }));
    }
  });
}
