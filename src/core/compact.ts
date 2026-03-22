import { generateText, type ModelMessage } from "ai";

import { getSummaryAgentModel } from "@/utils/model";
import { serializeContent } from "@/utils/searializer";

const RECENT_MESSAGE_COUNT = 12;
const MIN_MESSAGE_COUNT_FOR_COMPACTION = RECENT_MESSAGE_COUNT + 4;

export async function compactContext(messages: ModelMessage[]): Promise<ModelMessage[]> {
  if (messages.length <= MIN_MESSAGE_COUNT_FOR_COMPACTION) {
    return messages;
  }

  const messagesToCompact = messages.slice(0, -RECENT_MESSAGE_COUNT);
  const recentMessages = messages.slice(-RECENT_MESSAGE_COUNT);

  try {
    const result = await generateText({
      model: getSummaryAgentModel(),
      system: [
        "Summarize the earlier conversation so it can replace the original messages in context.",
        "Preserve concrete facts, decisions, constraints, open tasks, tool results, and user preferences.",
        "Do not add new information. Keep it compact and scannable."
      ].join(" "),
      messages: messagesToCompact
    });

    return [
      {
        role: "assistant",
        content: [{ type: "text", text: `Conversation summary:\n${result.text.trim()}` }]
      },
      ...recentMessages
    ];
  } catch {
    const fallbackSummary = messagesToCompact
      .map((message) => `${message.role}: ${serializeContent(message.content)}`.trim())
      .filter((value) => value !== "")
      .join("\n")
      .trim();

    if (fallbackSummary === "") {
      return recentMessages;
    }

    return [
      {
        role: "assistant",
        content: [{ type: "text", text: `Conversation summary:\n${fallbackSummary}` }]
      },
      ...recentMessages
    ];
  }
}
