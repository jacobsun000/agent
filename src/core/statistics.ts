import type { LanguageModelUsage } from "ai";

type TokenStats = {
  total: number;
  noCache: number;
  cacheRead: number;
  cacheWrite: number;
};

type OutputTokenStats = {
  total: number;
  text: number;
  reasoning: number;
};

export type UsageStatistics = {
  languageModelUsage: {
    inputTokens: TokenStats;
    outputTokens: OutputTokenStats;
  };
};

const ZERO_TOKEN_STATS: TokenStats = {
  total: 0,
  noCache: 0,
  cacheRead: 0,
  cacheWrite: 0
};

const ZERO_OUTPUT_TOKEN_STATS: OutputTokenStats = {
  total: 0,
  text: 0,
  reasoning: 0
};

const INITIAL_STATS: UsageStatistics = {
  languageModelUsage: {
    inputTokens: { ...ZERO_TOKEN_STATS },
    outputTokens: { ...ZERO_OUTPUT_TOKEN_STATS }
  }
};

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function cloneStats(stats: UsageStatistics): UsageStatistics {
  return {
    languageModelUsage: {
      inputTokens: { ...stats.languageModelUsage.inputTokens },
      outputTokens: { ...stats.languageModelUsage.outputTokens }
    }
  };
}

function extractInputStats(usage: LanguageModelUsage): TokenStats {
  const usageRecord = toRecord(usage);
  const inputValue = usageRecord.inputTokens;

  if (typeof inputValue === "number") {
    const cacheRead = toNumber(usageRecord.cachedInputTokens);
    return {
      total: inputValue,
      noCache: Math.max(0, inputValue - cacheRead),
      cacheRead,
      cacheWrite: 0
    };
  }

  const inputRecord = toRecord(inputValue);
  const total = toNumber(inputRecord.total);
  const cacheRead = toNumber(inputRecord.cacheRead);
  const cacheWrite = toNumber(inputRecord.cacheWrite);
  const noCache = toNumber(inputRecord.noCache);

  return {
    total,
    noCache: noCache > 0 ? noCache : Math.max(0, total - cacheRead),
    cacheRead,
    cacheWrite
  };
}

function extractOutputStats(usage: LanguageModelUsage): OutputTokenStats {
  const usageRecord = toRecord(usage);
  const outputValue = usageRecord.outputTokens;

  if (typeof outputValue === "number") {
    const reasoning = toNumber(usageRecord.reasoningTokens);
    return {
      total: outputValue,
      text: Math.max(0, outputValue - reasoning),
      reasoning
    };
  }

  const outputRecord = toRecord(outputValue);
  const total = toNumber(outputRecord.total);
  const reasoning = toNumber(outputRecord.reasoning);
  const text = toNumber(outputRecord.text);

  return {
    total,
    text: text > 0 ? text : Math.max(0, total - reasoning),
    reasoning
  };
}

export class Statistics {
  private static instance: Statistics | undefined;
  private stats: UsageStatistics;

  private constructor() {
    this.stats = cloneStats(INITIAL_STATS);
  }

  static getInstance(): Statistics {
    if (!Statistics.instance) {
      Statistics.instance = new Statistics();
    }

    return Statistics.instance;
  }

  addLanguageModelUsage(usage: LanguageModelUsage | undefined): void {
    if (!usage) {
      return;
    }

    const input = extractInputStats(usage);
    const output = extractOutputStats(usage);

    this.stats.languageModelUsage.inputTokens.total += input.total;
    this.stats.languageModelUsage.inputTokens.noCache += input.noCache;
    this.stats.languageModelUsage.inputTokens.cacheRead += input.cacheRead;
    this.stats.languageModelUsage.inputTokens.cacheWrite += input.cacheWrite;

    this.stats.languageModelUsage.outputTokens.total += output.total;
    this.stats.languageModelUsage.outputTokens.text += output.text;
    this.stats.languageModelUsage.outputTokens.reasoning += output.reasoning;
  }

  getCurrentStatistics(): UsageStatistics {
    return cloneStats(this.stats);
  }
}

