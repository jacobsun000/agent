import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  type ConversationMessage,
  type MemoryCategory,
  type MemoryItem,
  type MemoryRelation,
  type MemoryResource,
  type MemoryScope,
  type MemorySnapshot
} from "@/memory/types";
import { stableScopeKey } from "@/memory/utils";

export class SqliteMemoryRepository {
  private readonly database: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(path.dirname(dbPath), { recursive: true });
    }

    this.database = new DatabaseSync(dbPath);
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA journal_mode = WAL");
    this.initializeSchema();
  }

  close() {
    this.database.close();
  }

  insertCategoriesWithEmbeddings(input: {
    scope: MemoryScope;
    categories: Array<{ id: string; name: string; description: string; embedding: number[] | null; createdAt: string }>;
  }) {
    const statement = this.database.prepare(`
      INSERT INTO memory_categories (
        id, scope_key, scope_json, name, description, summary, embedding_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope_key, name) DO NOTHING
    `);
    const scopeKey = stableScopeKey(input.scope);
    const scopeJson = JSON.stringify(input.scope);

    for (const category of input.categories) {
      statement.run(
        category.id,
        scopeKey,
        scopeJson,
        category.name,
        category.description,
        "",
        JSON.stringify(category.embedding),
        category.createdAt,
        category.createdAt
      );
    }
  }

  appendRecentMessages(input: {
    scope: MemoryScope;
    messages: ConversationMessage[];
    createdAt: string;
  }) {
    const statement = this.database.prepare(`
      INSERT INTO recent_messages (scope_key, scope_json, role, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    const scopeKey = stableScopeKey(input.scope);
    const scopeJson = JSON.stringify(input.scope);

    for (const message of input.messages) {
      statement.run(scopeKey, scopeJson, message.role, message.content, input.createdAt);
    }
  }

  countRecentMessages(scope: MemoryScope): number {
    const row = this.database
      .prepare("SELECT COUNT(*) as count FROM recent_messages WHERE scope_key = ?")
      .get(stableScopeKey(scope)) as { count: number };
    return row.count;
  }

  getRecentMessages(scope: MemoryScope, limit: number): ConversationMessage[] {
    const rows = this.database
      .prepare(`
        SELECT role, content
        FROM recent_messages
        WHERE scope_key = ?
        ORDER BY id DESC
        LIMIT ?
      `)
      .all(stableScopeKey(scope), limit) as Array<{
      role: ConversationMessage["role"];
      content: string;
    }>;

    return rows.reverse().map((row) => ({
      role: row.role,
      content: row.content
    }));
  }

  popOldestRecentMessages(scope: MemoryScope, count: number): ConversationMessage[] {
    const rows = this.database
      .prepare(`
        SELECT id, role, content
        FROM recent_messages
        WHERE scope_key = ?
        ORDER BY id ASC
        LIMIT ?
      `)
      .all(stableScopeKey(scope), count) as Array<{
      id: number;
      role: ConversationMessage["role"];
      content: string;
    }>;

    if (rows.length === 0) {
      return [];
    }

    const deleteStatement = this.database.prepare("DELETE FROM recent_messages WHERE id = ?");
    for (const row of rows) {
      deleteStatement.run(row.id);
    }

    return rows.map((row) => ({
      role: row.role,
      content: row.content
    }));
  }

  insertResource(resource: MemoryResource) {
    this.database
      .prepare(`
        INSERT INTO resources (
          id, scope_key, scope_json, source, modality, content, caption, metadata_json,
          embedding_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        resource.id,
        stableScopeKey(resource.scope),
        JSON.stringify(resource.scope),
        resource.source,
        resource.modality,
        resource.content,
        resource.caption,
        JSON.stringify(resource.metadata),
        JSON.stringify(resource.embedding),
        resource.createdAt,
        resource.updatedAt
      );
  }

  getItemsByContentHash(scope: MemoryScope, contentHash: string): MemoryItem | null {
    const row = this.database
      .prepare(`
        SELECT *
        FROM memory_items
        WHERE scope_key = ? AND content_hash = ?
      `)
      .get(stableScopeKey(scope), contentHash) as Record<string, unknown> | undefined;

    return row ? this.mapItem(row) : null;
  }

  insertItem(item: MemoryItem) {
    this.database
      .prepare(`
        INSERT INTO memory_items (
          id, scope_key, scope_json, resource_id, memory_type, summary, evidence, embedding_json,
          content_hash, salience, times_seen, extra_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        item.id,
        stableScopeKey(item.scope),
        JSON.stringify(item.scope),
        item.resourceId,
        item.memoryType,
        item.summary,
        item.evidence,
        JSON.stringify(item.embedding),
        item.contentHash,
        item.salience,
        item.timesSeen,
        JSON.stringify(item.extra),
        item.createdAt,
        item.updatedAt
      );
  }

  updateItem(item: MemoryItem) {
    this.database
      .prepare(`
        UPDATE memory_items
        SET summary = ?, evidence = ?, embedding_json = ?, salience = ?, times_seen = ?,
            extra_json = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        item.summary,
        item.evidence,
        JSON.stringify(item.embedding),
        item.salience,
        item.timesSeen,
        JSON.stringify(item.extra),
        item.updatedAt,
        item.id
      );
  }

  upsertRelation(relation: MemoryRelation) {
    this.database
      .prepare(`
        INSERT INTO category_item_relations (
          id, scope_key, scope_json, category_id, item_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(category_id, item_id) DO NOTHING
      `)
      .run(
        relation.id,
        stableScopeKey(relation.scope),
        JSON.stringify(relation.scope),
        relation.categoryId,
        relation.itemId,
        relation.createdAt,
        relation.updatedAt
      );
  }

  listCategories(scope: MemoryScope): MemoryCategory[] {
    const rows = this.database
      .prepare(`
        SELECT category.*,
          COUNT(relation.item_id) as item_count
        FROM memory_categories as category
        LEFT JOIN category_item_relations as relation
          ON relation.category_id = category.id
        WHERE category.scope_key = ?
        GROUP BY category.id
        ORDER BY category.name ASC
      `)
      .all(stableScopeKey(scope)) as Array<Record<string, unknown>>;

    return rows.map((row) => this.mapCategory(row));
  }

  getCategoryByName(scope: MemoryScope, name: string): MemoryCategory | null {
    const row = this.database
      .prepare(`
        SELECT category.*,
          COUNT(relation.item_id) as item_count
        FROM memory_categories as category
        LEFT JOIN category_item_relations as relation
          ON relation.category_id = category.id
        WHERE category.scope_key = ? AND category.name = ?
        GROUP BY category.id
      `)
      .get(stableScopeKey(scope), name) as Record<string, unknown> | undefined;

    return row ? this.mapCategory(row) : null;
  }

  updateCategory(category: MemoryCategory) {
    this.database
      .prepare(`
        UPDATE memory_categories
        SET summary = ?, embedding_json = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(category.summary, JSON.stringify(category.embedding), category.updatedAt, category.id);
  }

  listItemsForCategoryIds(scope: MemoryScope, categoryIds: string[]): MemoryItem[] {
    if (categoryIds.length === 0) {
      return this.listItems(scope);
    }

    const placeholders = categoryIds.map(() => "?").join(", ");
    const statement = this.database.prepare(`
      SELECT DISTINCT item.*
      FROM memory_items as item
      INNER JOIN category_item_relations as relation
        ON relation.item_id = item.id
      WHERE item.scope_key = ?
        AND relation.category_id IN (${placeholders})
      ORDER BY item.updated_at DESC
    `);
    const rows = statement.all(stableScopeKey(scope), ...categoryIds) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapItem(row));
  }

  listItems(scope: MemoryScope): MemoryItem[] {
    const rows = this.database
      .prepare(`
        SELECT *
        FROM memory_items
        WHERE scope_key = ?
        ORDER BY updated_at DESC
      `)
      .all(stableScopeKey(scope)) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapItem(row));
  }

  listResources(scope: MemoryScope): MemoryResource[] {
    const rows = this.database
      .prepare(`
        SELECT *
        FROM resources
        WHERE scope_key = ?
        ORDER BY updated_at DESC
      `)
      .all(stableScopeKey(scope)) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapResource(row));
  }

  listResourcesByIds(scope: MemoryScope, resourceIds: string[]): MemoryResource[] {
    if (resourceIds.length === 0) {
      return [];
    }

    const placeholders = resourceIds.map(() => "?").join(", ");
    const statement = this.database.prepare(`
      SELECT *
      FROM resources
      WHERE scope_key = ? AND id IN (${placeholders})
      ORDER BY updated_at DESC
    `);
    const rows = statement.all(stableScopeKey(scope), ...resourceIds) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapResource(row));
  }

  clearScope(scope: MemoryScope) {
    const scopeKey = stableScopeKey(scope);
    for (const table of [
      "recent_messages",
      "category_item_relations",
      "memory_items",
      "resources",
      "memory_categories"
    ]) {
      this.database.prepare(`DELETE FROM ${table} WHERE scope_key = ?`).run(scopeKey);
    }
  }

  snapshot(): MemorySnapshot {
    const resources = this.listAllResources();
    const items = this.listAllItems();
    const categories = this.listAllCategories();
    const relations = this.listAllRelations();
    const recentMessages = (
      this.database
        .prepare(`
          SELECT scope_json, role, content, created_at
          FROM recent_messages
          ORDER BY id ASC
        `)
        .all() as Array<Record<string, unknown>>
    ).map((row) => ({
      scope: JSON.parse(String(row.scope_json)) as MemoryScope,
      role: String(row.role) as ConversationMessage["role"],
      content: String(row.content),
      createdAt: String(row.created_at)
    }));

    return {
      resources,
      items,
      categories,
      relations,
      recentMessages
    };
  }

  private listAllResources(): MemoryResource[] {
    return (this.database.prepare("SELECT * FROM resources").all() as Array<Record<string, unknown>>).map(
      (row) => this.mapResource(row)
    );
  }

  private listAllItems(): MemoryItem[] {
    return (this.database.prepare("SELECT * FROM memory_items").all() as Array<Record<string, unknown>>).map(
      (row) => this.mapItem(row)
    );
  }

  private listAllCategories(): MemoryCategory[] {
    return (
      this.database.prepare(`
        SELECT category.*,
          COUNT(relation.item_id) as item_count
        FROM memory_categories as category
        LEFT JOIN category_item_relations as relation
          ON relation.category_id = category.id
        GROUP BY category.id
      `).all() as Array<Record<string, unknown>>
    ).map((row) => this.mapCategory(row));
  }

  private listAllRelations(): MemoryRelation[] {
    return (
      this.database.prepare("SELECT * FROM category_item_relations").all() as Array<Record<string, unknown>>
    ).map((row) => this.mapRelation(row));
  }

  private mapResource(row: Record<string, unknown>): MemoryResource {
    return {
      id: String(row.id),
      source: String(row.source),
      modality: String(row.modality) as MemoryResource["modality"],
      content: String(row.content),
      caption: row.caption === null ? null : String(row.caption),
      metadata: JSON.parse(String(row.metadata_json)) as Record<string, string>,
      embedding: this.parseEmbedding(row.embedding_json),
      scope: JSON.parse(String(row.scope_json)) as MemoryScope,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  private mapItem(row: Record<string, unknown>): MemoryItem {
    return {
      id: String(row.id),
      resourceId: String(row.resource_id),
      memoryType: String(row.memory_type) as MemoryItem["memoryType"],
      summary: String(row.summary),
      evidence: String(row.evidence),
      embedding: this.parseEmbedding(row.embedding_json),
      categoryIds: this.listCategoryIdsForItem(String(row.id)),
      timesSeen: Number(row.times_seen),
      salience: Number(row.salience),
      contentHash: String(row.content_hash),
      extra: JSON.parse(String(row.extra_json)) as Record<string, string>,
      scope: JSON.parse(String(row.scope_json)) as MemoryScope,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  private mapCategory(row: Record<string, unknown>): MemoryCategory {
    return {
      id: String(row.id),
      name: String(row.name),
      description: String(row.description),
      summary: String(row.summary ?? ""),
      embedding: this.parseEmbedding(row.embedding_json),
      itemCount: Number(row.item_count ?? 0),
      scope: JSON.parse(String(row.scope_json)) as MemoryScope,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  private mapRelation(row: Record<string, unknown>): MemoryRelation {
    return {
      id: String(row.id),
      categoryId: String(row.category_id),
      itemId: String(row.item_id),
      scope: JSON.parse(String(row.scope_json)) as MemoryScope,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  private listCategoryIdsForItem(itemId: string): string[] {
    const rows = this.database
      .prepare(`
        SELECT category_id
        FROM category_item_relations
        WHERE item_id = ?
      `)
      .all(itemId) as Array<{ category_id: string }>;
    return rows.map((row) => row.category_id);
  }

  private parseEmbedding(value: unknown): number[] | null {
    if (value === null || value === undefined) {
      return null;
    }
    return JSON.parse(String(value)) as number[] | null;
  }

  private initializeSchema() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS resources (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        scope_json TEXT NOT NULL,
        source TEXT NOT NULL,
        modality TEXT NOT NULL,
        content TEXT NOT NULL,
        caption TEXT,
        metadata_json TEXT NOT NULL,
        embedding_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_resources_scope_key ON resources(scope_key);

      CREATE TABLE IF NOT EXISTS memory_categories (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        scope_json TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        summary TEXT NOT NULL,
        embedding_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(scope_key, name)
      );

      CREATE INDEX IF NOT EXISTS idx_categories_scope_key ON memory_categories(scope_key);

      CREATE TABLE IF NOT EXISTS memory_items (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        scope_json TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        memory_type TEXT NOT NULL,
        summary TEXT NOT NULL,
        evidence TEXT NOT NULL,
        embedding_json TEXT,
        content_hash TEXT NOT NULL,
        salience REAL NOT NULL,
        times_seen INTEGER NOT NULL,
        extra_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(scope_key, content_hash),
        FOREIGN KEY(resource_id) REFERENCES resources(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_items_scope_key ON memory_items(scope_key);

      CREATE TABLE IF NOT EXISTS category_item_relations (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        scope_json TEXT NOT NULL,
        category_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(category_id, item_id),
        FOREIGN KEY(category_id) REFERENCES memory_categories(id) ON DELETE CASCADE,
        FOREIGN KEY(item_id) REFERENCES memory_items(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_relations_scope_key ON category_item_relations(scope_key);

      CREATE TABLE IF NOT EXISTS recent_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope_key TEXT NOT NULL,
        scope_json TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_recent_messages_scope_key ON recent_messages(scope_key, id);
    `);
  }
}
