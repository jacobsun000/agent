import { type ModelMessage } from "ai";

export type MemoryModality = "conversation" | "document" | "note";

export type MemoryType =
  | "profile"
  | "event"
  | "knowledge"
  | "behavior"
  | "skill"
  | "tool";

export type MemoryScope = Record<string, string | number | boolean>;

export type MemoryWhereValue =
  | string
  | number
  | boolean
  | ReadonlyArray<string | number | boolean>;

export type MemoryWhere = Record<string, MemoryWhereValue>;

export type MemoryCategorySeed = {
  name: string;
  description: string;
};

export type MemoryRecordBase = {
  id: string;
  createdAt: string;
  updatedAt: string;
  scope: MemoryScope;
};

export type MemoryResource = MemoryRecordBase & {
  source: string;
  modality: MemoryModality;
  content: string;
  caption: string | null;
  metadata: Record<string, string>;
  embedding: number[] | null;
};

export type MemoryItem = MemoryRecordBase & {
  resourceId: string;
  memoryType: MemoryType;
  summary: string;
  evidence: string;
  embedding: number[] | null;
  categoryIds: string[];
  timesSeen: number;
  salience: number;
  contentHash: string;
  extra: Record<string, string>;
};

export type MemoryCategory = MemoryRecordBase & {
  name: string;
  description: string;
  summary: string;
  embedding: number[] | null;
  itemCount: number;
};

export type MemoryRelation = MemoryRecordBase & {
  categoryId: string;
  itemId: string;
};

export type ConversationMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
};

export type ConversationScope = {
  sessionId: string;
  userId?: string;
};

export type AddConversationMessagesInput = {
  scope: ConversationScope;
  messages: ConversationMessage[] | ModelMessage[];
  source?: string;
  metadata?: Record<string, string>;
};

export type AddConversationMessageInput = {
  scope: ConversationScope;
  message: ConversationMessage;
  source?: string;
  metadata?: Record<string, string>;
};

export type RememberTextInput = {
  scope: ConversationScope;
  text: string;
  source?: string;
  metadata?: Record<string, string>;
};

export type ConversationBuffer = {
  scope: ConversationScope;
  messages: ConversationMessage[];
};

export type MemoryHit<TRecord> = TRecord & {
  score: number;
  reasons: string[];
};

export type MemorizeResult = {
  resource: MemoryResource;
  items: MemoryItem[];
  categories: MemoryCategory[];
  relations: MemoryRelation[];
};

export type ConsolidationResult = {
  consolidated: boolean;
  consolidatedMessages: number;
  recentMessages: ConversationMessage[];
  memory?: MemorizeResult;
};

export type RecallOutput = {
  needsRetrieval: boolean;
  query: string;
  recentMessages: ConversationMessage[];
  categories: MemoryHit<MemoryCategory>[];
  items: MemoryHit<MemoryItem>[];
  resources: MemoryHit<MemoryResource>[];
  contextText: string;
};

export type MemorySnapshot = {
  resources: MemoryResource[];
  items: MemoryItem[];
  categories: MemoryCategory[];
  relations: MemoryRelation[];
  recentMessages: Array<ConversationMessage & { scope: MemoryScope; createdAt: string }>;
};

export type MemoryServiceOptions = {
  apiKey?: string;
  baseURL?: string;
  chatModel?: string;
  embeddingModel?: string;
  dbPath?: string;
  categories?: MemoryCategorySeed[];
  defaultScope?: MemoryScope;
  recentMessageLimit?: number;
  consolidationBufferMessages?: number;
  contextTokenLimit?: number;
  responseTokenReserve?: number;
};
