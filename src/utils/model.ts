import { createOpenAI } from "@ai-sdk/openai";
import { type LanguageModel } from "ai";

import { type Config } from "@/utils/config";

export type ParsedModel = {
  provider: string;
  modelId: string;
};

export function parseModel(value: string): ParsedModel {
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new Error("Model must be non-empty.");
  }

  const separatorIndex = trimmed.indexOf("/");
  if (separatorIndex === -1) {
    throw new Error("Model must be in the format '<provider>/<model>'.");
  }

  const provider = trimmed.slice(0, separatorIndex).trim();
  const modelId = trimmed.slice(separatorIndex + 1).trim();

  if (provider === "") {
    throw new Error("Model must start with '<provider>/'.");
  }

  if (modelId === "") {
    throw new Error("Model must include a model name after '<provider>/'.");
  }

  return {
    provider,
    modelId
  };
}

export function createLanguageModel(config: Config, model: string): LanguageModel {
  const parsedModel = parseModel(model);
  const provider = config.providers.find((entry) => entry.name === parsedModel.provider);

  if (!provider) {
    throw new Error(`No provider named '${parsedModel.provider}' configured.`);
  }

  switch (parsedModel.provider) {
    case "openai": {
      const openai = createOpenAI({ apiKey: provider.apiKey });
      return openai(parsedModel.modelId);
    }
    default:
      throw new Error(`Unsupported provider '${parsedModel.provider}'.`);
  }
}

export function createProviderClient(config: Config, providerName: string) {
  const provider = config.providers.find((entry) => entry.name === providerName);

  if (!provider) {
    throw new Error(`No provider named '${providerName}' configured.`);
  }

  switch (providerName) {
    case "openai":
      return createOpenAI({ apiKey: provider.apiKey });
    default:
      throw new Error(`Unsupported provider '${providerName}'.`);
  }
}
