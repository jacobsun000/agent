import path from "node:path";

import { createOpenAI } from "@ai-sdk/openai";
import { embed, embedMany, generateObject, generateText, type ModelMessage } from "ai";
import { z } from "zod";

import { buildCategorySummaryPrompt, buildConsolidationPrompt, MEMORY_TYPES } from "@/memory/prompts";
import { SqliteMemoryRepository } from "@/memory/sqlite";
import {
  type AddConversationMessageInput,
  type AddConversationMessagesInput,
  type ConsolidationResult,
  type ConversationBuffer,
  type ConversationMessage,
  type ConversationScope,
  type MemoryCategory,
  type MemoryCategorySeed,
  type MemoryHit,
  type MemoryItem,
  type MemoryRelation,
  type MemoryResource,
  type MemoryScope,
  type MemoryServiceOptions,
  type MemorySnapshot,
  type MemoryType,
  type RecallOutput
} from "@/memory/types";
import {
  DEFAULT_MEMORY_CATEGORIES,
  contentHash,
  cosineSimilarity,
  createId,
  extractPlainTextFromModelContent,
  formatConversation,
  mergeScope,
  nowIso,
  summarizeText
} from "@/memory/utils";

const DEFAULT_CHAT_MODEL = "gpt-4o-mini";
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_RECENT_MESSAGE_LIMIT = 100;
const DEFAULT_CONSOLIDATION_BUFFER_MESSAGES = 20;
const DEFAULT_DB_PATH = path.resolve(process.cwd(), "data", "memory.sqlite");

const consolidationSchema = z.object({
  resourceCaption: z.string().trim().min(1).max(200),
  items: z
    .array(
      z.object({
        memoryType: z.enum(MEMORY_TYPES),
        summary: z.string().trim().min(1).max(240),
        evidence: z.string().trim().min(1).max(400).optional(),
        categories: z.array(z.string().trim().min(1)).max(3)
      })
    )
    .max(20)
});

type ConsolidationOutput = z.infer<typeof consolidationSchema>;

export class MemoryService {
  private readonly repository: SqliteMemoryRepository;
  private readonly openai;
  private readonly chatModel;
  private readonly embeddingModel;
  private readonly categoryTemplates: MemoryCategorySeed[];
  private readonly defaultScope: MemoryScope;
  private readonly recentMessageLimit: number;
  private readonly consolidationTriggerMessageCount: number;

  constructor(options: MemoryServiceOptions = {}) {
    const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("MemoryService requires an OpenAI API key.");
    }

    this.openai = createOpenAI({
      apiKey,
      ...(options.baseURL ? { baseURL: options.baseURL } : {})
    });
    this.chatModel = this.openai.chat(options.chatModel ?? DEFAULT_CHAT_MODEL);
    this.embeddingModel = this.openai.embedding(options.embeddingModel ?? DEFAULT_EMBEDDING_MODEL);
    this.categoryTemplates = options.categories ?? DEFAULT_MEMORY_CATEGORIES;
    this.defaultScope = options.defaultScope ?? {};
    this.recentMessageLimit = Math.max(1, options.recentMessageLimit ?? DEFAULT_RECENT_MESSAGE_LIMIT);
    this.consolidationTriggerMessageCount =
      this.recentMessageLimit +
      Math.max(1, options.consolidationBufferMessages ?? DEFAULT_CONSOLIDATION_BUFFER_MESSAGES);

    this.repository = new SqliteMemoryRepository(options.dbPath ?? DEFAULT_DB_PATH);
  }

  async addConversationMessage(input: AddConversationMessageInput): Promise<ConsolidationResult> {
    return this.addConversationMessages({
      scope: input.scope,
      messages: [input.message],
      source: input.source,
      metadata: input.metadata
    });
  }

  async addConversationMessages(input: AddConversationMessagesInput): Promise<ConsolidationResult> {
    const scope = this.toMemoryScope(input.scope);
    await this.ensureScopeCategories(scope);

    const normalizedMessages = this.normalizeConversationMessages(input.messages);
    if (normalizedMessages.length === 0) {
      return {
        consolidated: false,
        consolidatedMessages: 0,
        recentMessages: this.repository.getRecentMessages(scope, this.recentMessageLimit)
      };
    }

    this.repository.appendRecentMessages({
      scope,
      messages: normalizedMessages,
      createdAt: nowIso()
    });

    const messageCount = this.repository.countRecentMessages(scope);
    if (messageCount <= this.consolidationTriggerMessageCount) {
      return {
        consolidated: false,
        consolidatedMessages: 0,
        recentMessages: this.repository.getRecentMessages(scope, this.recentMessageLimit)
      };
    }

    const consolidatedMessages = this.repository.popOldestRecentMessages(
      scope,
      messageCount - this.recentMessageLimit
    );
    const memory = await this.consolidateConversationChunk({
      scope,
      source: input.source ?? `conversation:${input.scope.sessionId}`,
      messages: consolidatedMessages,
      metadata: input.metadata ?? {}
    });

    return {
      consolidated: true,
      consolidatedMessages: consolidatedMessages.length,
      recentMessages: this.repository.getRecentMessages(scope, this.recentMessageLimit),
      memory
    };
  }

  getRecentMessages(scope: ConversationScope): ConversationMessage[] {
    return this.repository.getRecentMessages(this.toMemoryScope(scope), this.recentMessageLimit);
  }

  getConversationBuffer(scope: ConversationScope): ConversationBuffer {
    return {
      scope,
      messages: this.getRecentMessages(scope)
    };
  }

  async recall(input: {
    scope: ConversationScope;
    query: string;
    topK?: number;
    categoryTopK?: number;
    itemTopK?: number;
    resourceTopK?: number;
  }): Promise<RecallOutput> {
    const scope = this.toMemoryScope(input.scope);
    await this.ensureScopeCategories(scope);

    const recentMessages = this.repository.getRecentMessages(scope, this.recentMessageLimit);
    const { embedding: queryEmbedding } = await embed({
      model: this.embeddingModel,
      value: input.query
    });

    const categoryHits = this.rankCategories({
      categories: this.repository.listCategories(scope),
      queryEmbedding,
      topK: input.categoryTopK ?? input.topK ?? 5
    });

    const candidateItems = this.repository.listItemsForCategoryIds(
      scope,
      categoryHits.map((category) => category.id)
    );
    const itemHits = this.rankItems({
      items: candidateItems,
      queryEmbedding,
      topK: input.itemTopK ?? input.topK ?? 5
    });

    const resourceHits = this.rankResources({
      resources: this.repository.listResourcesByIds(
        scope,
        Array.from(new Set(itemHits.map((item) => item.resourceId)))
      ),
      queryEmbedding,
      topK: input.resourceTopK ?? input.topK ?? 5
    });

    const result: RecallOutput = {
      needsRetrieval: categoryHits.length > 0 || itemHits.length > 0 || resourceHits.length > 0,
      query: input.query,
      recentMessages,
      categories: categoryHits,
      items: itemHits,
      resources: resourceHits,
      contextText: this.buildRecallContext({
        recentMessages,
        categories: categoryHits,
        items: itemHits,
        resources: resourceHits
      })
    };

    return result;
  }

  async clearScope(scope: ConversationScope): Promise<void> {
    const memoryScope = this.toMemoryScope(scope);
    this.repository.clearScope(memoryScope);
    await this.ensureScopeCategories(memoryScope);
  }

  snapshot(): MemorySnapshot {
    return this.repository.snapshot();
  }

  close() {
    this.repository.close();
  }

  private async consolidateConversationChunk(input: {
    scope: MemoryScope;
    source: string;
    messages: ConversationMessage[];
    metadata: Record<string, string>;
  }): Promise<ConsolidationResult["memory"]> {
    if (input.messages.length === 0) {
      return undefined;
    }

    const categories = this.categoryTemplates;
    const conversation = formatConversation(input.messages);
    const extraction = await generateObject({
      model: this.chatModel,
      schema: consolidationSchema,
      prompt: buildConsolidationPrompt({
        conversation,
        categories
      })
    });

    const payload = extraction.object as ConsolidationOutput;
    const resourceEmbedding = payload.resourceCaption
      ? (
          await embed({
            model: this.embeddingModel,
            value: payload.resourceCaption
          })
        ).embedding
      : null;

    const timestamp = nowIso();
    const resource: MemoryResource = {
      id: createId(),
      source: input.source,
      modality: "conversation",
      content: conversation,
      caption: payload.resourceCaption,
      metadata: input.metadata,
      embedding: resourceEmbedding,
      scope: input.scope,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.repository.insertResource(resource);

    const items = await this.persistMemoryItems({
      scope: input.scope,
      resourceId: resource.id,
      items: payload.items,
      createdAt: timestamp
    });
    const affectedCategoryIds = Array.from(
      new Set(items.flatMap((item) => item.categoryIds))
    );
    const categoriesAfterUpdate = await this.updateCategorySummaries({
      scope: input.scope,
      affectedCategoryIds
    });
    const relations = this.collectRelations(items);

    return {
      resource,
      items,
      categories: categoriesAfterUpdate,
      relations
    };
  }

  private async persistMemoryItems(input: {
    scope: MemoryScope;
    resourceId: string;
    items: ConsolidationOutput["items"];
    createdAt: string;
  }): Promise<MemoryItem[]> {
    if (input.items.length === 0) {
      return [];
    }

    const { embeddings } = await embedMany({
      model: this.embeddingModel,
      values: input.items.map((item) => item.summary)
    });

    const persisted: MemoryItem[] = [];
    for (const [index, extracted] of input.items.entries()) {
      const normalizedCategories = this.normalizeCategoryNames(extracted.categories);
      const contentFingerprint = contentHash(`${extracted.memoryType}:${extracted.summary}`);
      const existing = this.repository.getItemsByContentHash(input.scope, contentFingerprint);

      let item: MemoryItem;
      if (existing) {
        item = {
          ...existing,
          evidence: extracted.evidence ?? existing.evidence,
          embedding: embeddings[index] ?? existing.embedding,
          salience: Number((existing.salience + 0.2).toFixed(3)),
          timesSeen: existing.timesSeen + 1,
          updatedAt: nowIso()
        };
        this.repository.updateItem(item);
      } else {
        item = {
          id: createId(),
          resourceId: input.resourceId,
          memoryType: extracted.memoryType as MemoryType,
          summary: extracted.summary,
          evidence: extracted.evidence ?? extracted.summary,
          embedding: embeddings[index] ?? null,
          categoryIds: [],
          timesSeen: 1,
          salience: 1,
          contentHash: contentFingerprint,
          extra: {},
          scope: input.scope,
          createdAt: input.createdAt,
          updatedAt: input.createdAt
        };
        this.repository.insertItem(item);
      }

      const categoryIds: string[] = [];
      for (const categoryName of normalizedCategories) {
        const category = this.repository.getCategoryByName(input.scope, categoryName);
        if (!category) {
          continue;
        }

        const relation: MemoryRelation = {
          id: createId(),
          categoryId: category.id,
          itemId: item.id,
          scope: input.scope,
          createdAt: nowIso(),
          updatedAt: nowIso()
        };
        this.repository.upsertRelation(relation);
        categoryIds.push(category.id);
      }

      item.categoryIds = categoryIds;
      persisted.push(item);
    }

    return persisted;
  }

  private async updateCategorySummaries(input: {
    scope: MemoryScope;
    affectedCategoryIds: string[];
  }): Promise<MemoryCategory[]> {
    const categories = this.repository.listCategories(input.scope).filter((category) =>
      input.affectedCategoryIds.includes(category.id)
    );

    for (const category of categories) {
      const items = this.repository
        .listItemsForCategoryIds(input.scope, [category.id])
        .slice(0, 12)
        .map((item) => item.summary);

      const { text } = await generateText({
        model: this.chatModel,
        prompt: buildCategorySummaryPrompt({
          categoryName: category.name,
          categoryDescription: category.description,
          currentSummary: category.summary,
          newItems: items
        })
      });

      const summary = text.trim();
      const embedding = summary
        ? (
            await embed({
              model: this.embeddingModel,
              value: summary
            })
          ).embedding
        : category.embedding;

      this.repository.updateCategory({
        ...category,
        summary,
        embedding,
        updatedAt: nowIso()
      });
    }

    return this.repository.listCategories(input.scope);
  }

  private rankCategories(input: {
    categories: MemoryCategory[];
    queryEmbedding: number[];
    topK: number;
  }): Array<MemoryHit<MemoryCategory>> {
    return input.categories
      .map((category) => {
        const score = cosineSimilarity(input.queryEmbedding, category.embedding);
        return {
          ...category,
          score,
          reasons: [`cosine:${score.toFixed(3)}`]
        };
      })
      .filter((category) => category.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, input.topK);
  }

  private rankItems(input: {
    items: MemoryItem[];
    queryEmbedding: number[];
    topK: number;
  }): Array<MemoryHit<MemoryItem>> {
    return input.items
      .map((item) => {
        const vectorScore = cosineSimilarity(input.queryEmbedding, item.embedding);
        const salienceBonus = item.salience * 0.03;
        const score = vectorScore + salienceBonus;
        return {
          ...item,
          score,
          reasons: [`cosine:${vectorScore.toFixed(3)}`, `salience:${item.salience.toFixed(2)}`]
        };
      })
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, input.topK);
  }

  private rankResources(input: {
    resources: MemoryResource[];
    queryEmbedding: number[];
    topK: number;
  }): Array<MemoryHit<MemoryResource>> {
    return input.resources
      .map((resource) => {
        const score = cosineSimilarity(input.queryEmbedding, resource.embedding);
        return {
          ...resource,
          score,
          reasons: [`cosine:${score.toFixed(3)}`]
        };
      })
      .filter((resource) => resource.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, input.topK);
  }

  private buildRecallContext(input: {
    recentMessages: ConversationMessage[];
    categories: Array<MemoryHit<MemoryCategory>>;
    items: Array<MemoryHit<MemoryItem>>;
    resources: Array<MemoryHit<MemoryResource>>;
  }): string {
    const parts: string[] = [];

    if (input.recentMessages.length > 0) {
      parts.push("<recent_messages>");
      parts.push(
        input.recentMessages
          .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
          .join("\n")
      );
      parts.push("</recent_messages>");
    }

    if (input.categories.length > 0) {
      parts.push("<memory_categories>");
      parts.push(
        input.categories
          .map((category) => `- ${category.name}: ${category.summary || category.description}`)
          .join("\n")
      );
      parts.push("</memory_categories>");
    }

    if (input.items.length > 0) {
      parts.push("<memory_items>");
      parts.push(input.items.map((item) => `- ${item.summary}`).join("\n"));
      parts.push("</memory_items>");
    }

    if (input.resources.length > 0) {
      parts.push("<memory_resources>");
      parts.push(
        input.resources
          .map((resource) => `- ${resource.caption ?? summarizeText(resource.content, 120)}`)
          .join("\n")
      );
      parts.push("</memory_resources>");
    }

    return parts.join("\n");
  }

  private collectRelations(items: MemoryItem[]): MemoryRelation[] {
    return items.flatMap((item) =>
      item.categoryIds.map((categoryId) => ({
        id: createId(),
        categoryId,
        itemId: item.id,
        scope: item.scope,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt
      }))
    );
  }

  private async ensureScopeCategories(scope: MemoryScope): Promise<void> {
    const existing = this.repository.listCategories(scope);
    const existingNames = new Set(existing.map((category) => category.name));
    const missing = this.categoryTemplates.filter((category) => !existingNames.has(category.name));

    if (missing.length === 0) {
      return;
    }

    const { embeddings } = await embedMany({
      model: this.embeddingModel,
      values: missing.map((category) => `${category.name}: ${category.description}`)
    });

    const createdAt = nowIso();
    this.repository.insertCategoriesWithEmbeddings({
      scope,
      categories: missing.map((category, index) => ({
        id: createId(),
        name: category.name,
        description: category.description,
        embedding: embeddings[index] ?? null,
        createdAt
      }))
    });
  }

  private normalizeConversationMessages(messages: ConversationMessage[] | ModelMessage[]): ConversationMessage[] {
    return messages
      .map((message) => {
        const role =
          message.role === "system" ||
          message.role === "user" ||
          message.role === "assistant" ||
          message.role === "tool"
            ? message.role
            : "tool";
        const content =
          "content" in message
            ? extractPlainTextFromModelContent(message.content) ||
              (typeof message.content === "string" ? message.content : "")
            : "";

        return {
          role,
          content: content.trim()
        };
      })
      .filter((message) => message.content.length > 0);
  }

  private normalizeCategoryNames(categories: string[]): string[] {
    const allowed = new Set(this.categoryTemplates.map((category) => category.name));
    const normalized = categories
      .map((category) => category.trim().toLowerCase().replace(/\s+/g, "_"))
      .filter((category) => allowed.has(category));

    if (normalized.length > 0) {
      return Array.from(new Set(normalized));
    }

    return ["knowledge"];
  }

  private toMemoryScope(scope: ConversationScope): MemoryScope {
    return mergeScope(this.defaultScope, {
      sessionId: scope.sessionId,
      ...(scope.userId ? { userId: scope.userId } : {})
    });
  }
}
