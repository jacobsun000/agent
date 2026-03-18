import { tool } from "ai";
import { z } from "zod";
import { TavilyClient } from "@tavily/core";

const DEFAULT_MAX_CHARS = 24_000;
const MAX_ALLOWED_CHARS = 100_000;

const webFetchInputSchema = z.object({
  url: z.url().describe("Webpage URL to fetch."),
  maxChars: z.number().int().positive().max(MAX_ALLOWED_CHARS).optional()
    .describe(`Maximum markdown characters to return (default: ${DEFAULT_MAX_CHARS}).`)
});

type WebFetchToolConfig = {
  tavily: TavilyClient;
};

export function createWebFetchTool(config: WebFetchToolConfig) {
  return tool({
    title: "web_fetch",
    description: "Fetch a webpage and return its markdown content.",
    inputSchema: webFetchInputSchema,
    async execute(input) {
      const result = await config.tavily.extract([input.url], {
        format: "markdown"
      });

      const extracted = result.results[0];
      if (!extracted?.rawContent) {
        const failed = result.failedResults[0];
        if (failed) {
          throw new Error(`Failed to fetch ${failed.url}: ${failed.error}`);
        }
        throw new Error(`No content could be extracted from ${input.url}.`);
      }

      const maxChars = input.maxChars ?? DEFAULT_MAX_CHARS;
      const markdown = truncate(extracted.rawContent, maxChars);
      return {
        url: extracted.url,
        title: extracted.title,
        markdown
      };
    }
  });
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}\n\n...[truncated, ${value.length - maxChars} more chars]`;
}
