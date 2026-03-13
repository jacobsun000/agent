import { ModelMessage } from "ai";
import OpenAI from "openai";

import { config } from "@/utils/config";
import { ResponseInputItem } from "openai/resources/responses/responses.js";

const openai = new OpenAI({
  apiKey: config.providers.find((entry) => entry.name === "openai")?.apiKey
});

export async function compactContext(messages: ModelMessage[]): Promise<ModelMessage[]> {
  const input = (messages as unknown) as ResponseInputItem[];
  const result = await openai.responses.compact({ model: 'gpt-5.4', input });
  return (result.output as unknown) as ModelMessage[];
}
