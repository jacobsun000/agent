import { type UsageStatistics } from "@/core/statistics";

export type SupportedCommand = "new" | "compact" | "stats";

export type ParsedCommand = {
  name: SupportedCommand;
  raw: string;
};

export type CommandActions = {
  clearContext: () => void;
  compactContext: () => Promise<void>;
  getStatistics: () => UsageStatistics;
  dispatchResult: (message: string) => Promise<void>;
};

const COMMAND_NAME_BY_TOKEN: Record<string, SupportedCommand> = {
  new: "new",
  compact: "compact",
  stats: "stats"
};

const COMMAND_PATTERN = /^\/([a-z]+)(?:@[a-z0-9_]+)?$/i;

export function parseCommand(text: string): ParsedCommand | undefined {
  const token = text.trim().split(/\s+/)[0];
  if (!token) {
    return undefined;
  }

  const match = COMMAND_PATTERN.exec(token);
  if (!match) {
    return undefined;
  }

  const name = COMMAND_NAME_BY_TOKEN[match[1].toLowerCase()];
  if (!name) {
    return undefined;
  }

  return {
    name,
    raw: token
  };
}

export async function applyCommand(input: {
  command: ParsedCommand;
  actions: CommandActions;
}): Promise<void> {
  const { command, actions } = input;

  switch (command.name) {
    case "new": {
      actions.clearContext();
      await actions.dispatchResult("Started a new conversation. Context was cleared.");
      return;
    }
    case "compact": {
      await actions.compactContext();
      await actions.dispatchResult("Compaction complete. Conversation context is now condensed.");
      return;
    }
    case "stats": {
      const statistics = actions.getStatistics();
      await actions.dispatchResult(formatStatisticsMarkdown(statistics));
      return;
    }
  }
}

export function formatStatisticsMarkdown(stats: UsageStatistics): string {
  const input = stats.languageModelUsage.inputTokens;
  const output = stats.languageModelUsage.outputTokens;

  return [
    "## Statistics",
    "",
    "### Input Tokens",
    `- Total: ${input.total}`,
    `- No cache: ${input.noCache}`,
    `- Cache read: ${input.cacheRead}`,
    `- Cache write: ${input.cacheWrite}`,
    "",
    "### Output Tokens",
    `- Total: ${output.total}`,
    `- Text: ${output.text}`,
    `- Reasoning: ${output.reasoning}`
  ].join("\n");
}
