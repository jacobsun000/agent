import { createOpenAI } from "@ai-sdk/openai";
import { experimental_transcribe as transcribe } from "ai";

import { getProviderConfig, type Config } from "@/utils/config";
import { createLogger } from "@/utils/logger";
import { parseModel } from "@/utils/model";

const logger = createLogger("service:transcribe");

export type TranscriptionInput = {
  audio: Uint8Array;
  mimeType: string;
  filename?: string;
};

export type TranscriptionService = {
  transcribe(input: TranscriptionInput): Promise<string>;
};

export function createTranscriptionService(config: Config): TranscriptionService {
  const parsedModel = parseModel(config.agent.transcriptionModel);

  switch (parsedModel.provider) {
    case "openai":
      return createOpenAITranscriptionService(config, parsedModel.modelId);
    default:
      throw new Error(`Unsupported transcription provider '${parsedModel.provider}'.`);
  }
}

function createOpenAITranscriptionService(config: Config, modelId: string): TranscriptionService {
  const provider = getProviderConfig(config, config.agent.transcriptionModel);
  const openai = createOpenAI({ apiKey: provider.apiKey });

  return {
    async transcribe(input) {
      const result = await transcribe({
        model: openai.transcription(modelId),
        audio: Buffer.from(input.audio)
      });

      const text = result.text?.trim();
      if (!text) {
        logger.warn("Received empty transcription from provider.");
        throw new Error("Transcription returned empty text.");
      }

      return text;
    }
  };
}
