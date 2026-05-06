// =====================================================================
// SUPABASE CLIENT — Supabase PostgreSQL via Prisma (PostgREST-compatible API)
//
// This module provides a Prisma-based PostgREST query builder API.
// All 110+ API routes using `db.from('table').select().eq()...` continue
// to work unchanged.
//
// Connection: Prisma Client → Supabase PostgreSQL (cloud)
//
// Exports:
//   db             — main query client (PostgREST-compatible)
//   supabaseAdmin — alias for db
//   prisma         — raw Prisma Client for complex queries
// =====================================================================

import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// ─────────────────────────────────────────────────────────────────────
// FORCE READ DATABASE_URL FROM .env FILE
// Shell environment may have a stale/incorrect DATABASE_URL (e.g. SQLite).
// We must always read from the project's .env file first.
// ─────────────────────────────────────────────────────────────────────

function loadDatabaseUrl(): string {
  try {
    const envPath = resolve(process.cwd(), '.env');
    const envContent = readFileSync(envPath, 'utf-8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('DATABASE_URL=') && !trimmed.startsWith('#')) {
        const url = trimmed.substring('DATABASE_URL='.length).replace(/^["']|["']$/g, '');
        if (url.startsWith('postgresql://') || url.startsWith('postgres://')) {
          return url;
        }
      }
    }
  } catch {}
  // Fallback to process.env
  return process.env.DATABASE_URL || '';
}

// ─────────────────────────────────────────────────────────────────────
// PRISMA CLIENT (singleton)
// ─────────────────────────────────────────────────────────────────────

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };
const _resolvedDbUrl = loadDatabaseUrl();

// Add connection pool parameters based on STB config
import { DB_POOL } from './stb-config';

function buildPooledUrl(url: string): string {
  try {
    const u = new URL(url);
    const isPooler = u.port === '6543' || u.searchParams.has('pgbouncer');
    if (isPooler) {
      // Don't override connection_limit — Supavisor manages the pool
      u.searchParams.set('pool_timeout', '10');
      return u.toString();
    }
    // Direct connection — set limit from STB config
    u.searchParams.set('connection_limit', String(DB_POOL.tx.max));
    u.searchParams.set('pool_timeout', String(Math.floor(DB_POOL.tx.connectionTimeoutMs / 1000)));
    return u.toString();
  } catch {
    return url;
  }
}

export const prisma = globalForPrisma.prisma || new PrismaClient({
  datasourceUrl: buildPooledUrl(_resolvedDbUrl),
  // Limit connections for multi-user — prevents connection exhaustion on Supabase
  log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
});
// Save singleton in ALL environments to prevent connection leaks in production
globalForPrisma.prisma = globalForPrisma.prisma ?? prisma;

// ─────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────

export type PostgrestError = { message: string; code: string; status?: number };
export type PostgrestResult<T = any> = {
  data: T | null;
  error: PostgrestError | null;
  count: number | null;
  status?: number;
  statusText?: string;
};

// ─────────────────────────────────────────────────────────────────────
// TABLE NAME → PRISMA MODEL MAPPING
// ─────────────────────────────────────────────────────────────────────

const TABLE_TO_MODEL: Record<string, string> = {
  users: 'user',
  products: 'product',
  unit_products: 'unitProduct',
  customers: 'customer',
  transactions: 'transaction',
  transaction_items: 'transactionItem',
  payments: 'payment',
  settings: 'setting',
  logs: 'log',
  events: 'event',
  units: 'unit',
  user_units: 'userUnit',
  password_resets: 'passwordReset',
  suppliers: 'supplier',
  salary_payments: 'salaryPayment',
  bank_accounts: 'bankAccount',
  cash_boxes: 'cashBox',
  finance_requests: 'financeRequest',
  expenses: 'expense',
  fund_transfers: 'fundTransfer',
  company_debts: 'companyDebt',
  company_debt_payments: 'companyDebtPayment',
  receivables: 'receivable',
  receivable_follow_ups: 'receivableFollowUp',
  sales_targets: 'salesTarget',
  sales_tasks: 'salesTask',
  sales_task_reports: 'salesTaskReport',
  courier_cash: 'courierCash',
  courier_handovers: 'courierHandover',
  custom_roles: 'customRole',
  payment_proofs: 'paymentProof',
  customer_follow_ups: 'customerFollowUp',
  customer_prices: 'customerPrice',
  customer_referral: 'customerReferral',
  cashback_config: 'cashbackConfig',
  cashback_log: 'cashbackLog',
  cashback_withdrawal: 'cashbackWithdrawal',
  finance_ledger: 'financeLedger',
};

// ─────────────────────────────────────────────────────────────────────
// FIELD NAME CONVERSION (snake_case ↔ camelCase)
// ─────────────────────────────────────────────────────────────────────

/** snake_case to camelCase */
function snakeToCamel(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

/** camelCase to snake_case */
function camelToSnake(str: string): string {
  return str.replace(/([A-Z])/g, (letter, index) =>
    index === 0 ? letter.toLowerCase() : `_${letter.toLowerCase()}`
  );
}

// ─────────────────────────────────────────────────────────────────────
// PRISMA TYPE SERIALIZATION
// Prisma Decimal objects have {s, e, d} internal structure.
// Prisma DateTime objects are Date instances.
// Both must be serialized before sending to the frontend,
// otherwise React throws "Objects are not valid as a React child".
// ─────────────────────────────────────────────────────────────────────

/** Check if value is a Prisma Decimal-like object */
function isDecimalLike(obj: any): boolean {
  if (!obj || typeof obj !== 'object') return false;
  if (obj instanceof Date) return false;
  if (Array.isArray(obj)) return false;
  return typeof obj.toJSON === 'function' || ('s' in obj && 'e' in obj && 'd' in obj);
}

/** Serialize a Decimal-like object to number */
function serializeDecimal(obj: any): number {
  if (typeof obj.toJSON === 'function') {
    const result = obj.toJSON();
    return typeof result === 'number' ? result : parseFloat(String(result));
  }
  return parseFloat(String(obj)) || 0;
}

/** Convert all keys in an object from camelCase to snake_case (recursive) */
function toSnakeCaseDeep(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (obj instanceof Date) return obj.toISOString();
  if (isDecimalLike(obj)) return serializeDecimal(obj);
  if (Buffer.isBuffer(obj)) return obj.toString('base64');
  if (Array.isArray(obj)) return obj.map(toSnakeCaseDeep);
  if (typeof obj === 'object') {
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[camelToSnake(key)] = toSnakeCaseDeep(value);
    }
    return result;
  }
  return obj;
}

/** Convert all keys in an object from snake_case to camelCase (recursive) */
function toCamelCaseDeep(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (obj instanceof Date) return obj.toISOString();
  if (isDecimalLike(obj)) return serializeDecimal(obj);
  if (Buffer.isBuffer(obj)) return obj.toString('base64');
  if (Array.isArray(obj)) return obj.map(toCamelCaseDeep);
  if (typeof obj === 'object') {
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[snakeToCamel(key)] = toCamelCaseDeep(value);
    }
    return result;
  }
  return obj;
}

// ─────────────────────────────────────────────────────────────────────
// PARSE POSTGREST SELECT STRING INTO PRISMA select/include
// ─────────────────────────────────────────────────────────────────────

interface SelectOptions {
  count?: 'exact' | 'planned' | 'estimated';
  head?: boolean;
}

/**
 * Build a Prisma-compatible config object for a nested relation's fields.
 *
 * PostgREST examples and their Prisma equivalents:
 *   - '*'                       → true (include all fields)
 *   - 'id, name'                → { select: { id: true, name: true } }
 *   - '*, relation:other(*)'    → { include: { relation: true } }
 *   - 'id, relation:other(*)'   → { select: { id: true, relation: { include: { ... } } } }
 *   - 'id, name, rel:tbl(id)'   → { select: { id: true, name: true, rel: { select: { id: true } } } }
 *
 * KEY PRISMA RULE: Relations MUST be inside `select` or `include` at every nesting level.
 * { relation: true } is ONLY valid at the top-level of `select` or `include`.
 */
function buildNestedConfig(fieldsStr: string): Record<string, any> | true {
  if (fieldsStr.trim() === '*') {
    return true; // Include all fields — Prisma shorthand
  }

  const nestedParse = parseSelectString(fieldsStr);
  const hasScalarFields = nestedParse.selectFields && Object.keys(nestedParse.selectFields).length > 0;
  const hasRelations = nestedParse.includeConfig && Object.keys(nestedParse.includeConfig).length > 0;

  if (hasScalarFields && hasRelations) {
    // Mix of scalar fields + relations → use select, put relations inside it
    return {
      select: {
        ...nestedParse.selectFields,
        ...nestedParse.includeConfig,
      },
    };
  } else if (hasScalarFields) {
    // Only scalar fields → use select
    return { select: nestedParse.selectFields };
  } else if (hasRelations) {
    // Only relations (no scalar fields, e.g. '*, relation:other(*)' but * was stripped)
    // → use include for the relations
    return { include: nestedParse.includeConfig };
  }

  // Fallback — shouldn't happen
  return true;
}

/**
 * Parse a PostgREST select string like '*, related:related_table(*)'
 * into Prisma include/select config.
 */
function parseSelectString(selectStr: string): {
  selectFields: Record<string, boolean> | null;
  includeConfig: Record<string, any> | null;
} {
  // Simple select: '*' — return all fields, no includes
  if (selectStr.trim() === '*') {
    return { selectFields: null, includeConfig: null };
  }

  const selectFields: Record<string, boolean> = {};
  const includeConfig: Record<string, any> = {};

  // Split by comma (but be careful with nested parens)
  const parts = splitSelectParts(selectStr);

  for (const part of parts) {
    const trimmed = part.trim();

    // Check for embedded relation: 'alias:table_name!fkey(fields)' or 'alias:table_name(fields)'
    // Handle nested parentheses like 'items:transaction_items(*, product:products(*))'
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx > 0) {
      const alias = trimmed.substring(0, colonIdx);
      const rest = trimmed.substring(colonIdx + 1);
      const parenResult = findMatchingParens(rest);
      if (parenResult) {
        const tablePart = parenResult.before.replace(/![\w.]+$/, '').trim();
        const nestedFields = parenResult.inside.trim();
        const modelName = TABLE_TO_MODEL[tablePart];
        if (modelName && /^[\w]+$/.test(alias)) {
          const nestedConfig = buildNestedConfig(nestedFields || '*');
          const includeKey = snakeToCamel(alias);
          includeConfig[includeKey] = nestedConfig;
        }
        continue;
      }
    }

    // Check for direct relation: 'table_name!fkey(fields)' or 'table_name(fields)'
    const parenResult = findMatchingParens(trimmed);
    if (parenResult) {
      const tablePart = parenResult.before.replace(/![\w.]+$/, '').trim();
      const nestedFields = parenResult.inside.trim();
      const modelName = TABLE_TO_MODEL[tablePart];
      if (modelName && /^[\w]+$/.test(tablePart)) {
        const nestedConfig = buildNestedConfig(nestedFields);
        includeConfig[modelName] = nestedConfig;
      }
      continue;
    }

    // Simple field (but skip bare '*' — it means "all fields", not a column name)
    if (!trimmed.includes('(') && !trimmed.includes(':') && trimmed !== '*') {
      selectFields[snakeToCamel(trimmed)] = true;
    }
  }

  return { selectFields, includeConfig };
}

/**
 * Find the outermost balanced parentheses in a string.
 * e.g. 'transaction_items(*, product:products(*))' returns { before: 'transaction_items', inside: '*, product:products(*)' }
 * Returns null if no valid outermost parens found.
 */
function findMatchingParens(str: string): { before: string; inside: string } | null {
  const openIdx = str.indexOf('(');
  if (openIdx === -1) return null;

  let depth = 0;
  for (let i = openIdx; i < str.length; i++) {
    if (str[i] === '(') depth++;
    else if (str[i] === ')') {
      depth--;
      if (depth === 0) {
        // Found matching close paren at position i
        return {
          before: str.substring(0, openIdx),
          inside: str.substring(openIdx + 1, i),
        };
      }
    }
  }
  return null;
}

/** Split select string by commas, respecting parentheses nesting */
function splitSelectParts(str: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';

  for (const char of str) {
    if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

// ─────────────────────────────────────────────────────────────────────
// POSTGREST QUERY BUILDER
// ─────────────────────────────────────────────────────────────────────

type FilterOp =
  | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'ilike' | 'like' | 'in' | 'is' | 'not'
  | 'or' | 'and';

interface FilterCondition {
  op: FilterOp;
  field: string;
  value: any;
}

class PostgrestQueryBuilder {
  private tableName: string;
  private modelName: string;
  private filters: FilterCondition[] = [];
  private orderClauses: Array<{ column: string; ascending: boolean }> = [];
  private rangeFrom: number | null = null;
  private rangeTo: number | null = null;
  private limitCount: number | null = null;
  private singleMode: 'single' | 'maybeSingle' | null = null;
  private selectFields: Record<string, boolean> | null = null;
  private includeConfig: Record<string, any> | null = null;
  private countMode: 'exact' | null = null;
  private operation: 'select' | 'insert' | 'update' | 'delete' | 'upsert' | null = null;
  private insertData: any = null;
  private updateData: any = null;
  private upsertConflict: string | null = null;
  private headOnly: boolean = false;

  constructor(tableName: string) {
    this.tableName = tableName;
    this.modelName = TABLE_TO_MODEL[tableName] || tableName;
  }

  // ─── FILTER METHODS ──────────────────────────────────────────

  eq(column: string, value: any): this {
    this.filters.push({ op: 'eq', field: column, value });
    return this;
  }

  neq(column: string, value: any): this {
    this.filters.push({ op: 'neq', field: column, value });
    return this;
  }

  gt(column: string, value: any): this {
    this.filters.push({ op: 'gt', field: column, value });
    return this;
  }

  gte(column: string, value: any): this {
    this.filters.push({ op: 'gte', field: column, value });
    return this;
  }

  lt(column: string, value: any): this {
    this.filters.push({ op: 'lt', field: column, value });
    return this;
  }

  lte(column: string, value: any): this {
    this.filters.push({ op: 'lte', field: column, value });
    return this;
  }

  ilike(column: string, pattern: string): this {
    this.filters.push({ op: 'ilike', field: column, value: pattern });
    return this;
  }

  like(column: string, pattern: string): this {
    this.filters.push({ op: 'like', field: column, value: pattern });
    return this;
  }

  in(column: string, values: any[]): this {
    this.filters.push({ op: 'in', field: column, value: values });
    return this;
  }

  is(column: string, value: any): this {
    this.filters.push({ op: 'is', field: column, value });
    return this;
  }

  not(column: string, operator: string, value: any): this {
    // PostgREST: .not('col', 'eq', 'val')
    this.filters.push({ op: 'not', field: column, value: { operator, value } });
    return this;
  }

  or(filters: string, options?: { referencedTable?: string }): this {
    this.filters.push({ op: 'or', field: '', value: filters });
    return this;
  }

  and(filters: string, options?: { referencedTable?: string }): this {
    this.filters.push({ op: 'and', field: '', value: filters });
    return this;
  }

  // ─── ORDERING ───────────────────────────────────────────────

  order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }): this {
    this.orderClauses.push({
      column,
      ascending: options?.ascending !== false,
    });
    return this;
  }

  // ─── PAGINATION ─────────────────────────────────────────────

  range(from: number, to: number): this {
    this.rangeFrom = from;
    this.rangeTo = to;
    return this;
  }

  limit(n: number): this {
    this.limitCount = n;
    return this;
  }

  // ─── RESULT MODES ───────────────────────────────────────────

  single(): this {
    this.singleMode = 'single';
    return this;
  }

  maybeSingle(): this {
    this.singleMode = 'maybeSingle';
    return this;
  }

  // ─── SELECT ─────────────────────────────────────────────────
  // When chained after insert/update/delete, select() sets return fields
  // but does NOT override the operation (PostgREST behavior).

  select(fields?: string, options?: SelectOptions): this {
    // Don't override insert/update/delete — select() after write ops means "return these fields"
    if (this.operation !== 'insert' && this.operation !== 'update' && this.operation !== 'delete') {
      this.operation = 'select';
    }
    if (fields !== undefined) {
      const parsed = parseSelectString(fields);
      this.selectFields = parsed.selectFields;
      this.includeConfig = parsed.includeConfig;
    }
    if (options?.count) {
      this.countMode = options.count;
    }
    if (options?.head) {
      this.headOnly = true;
    }
    return this;
  }

  // ─── INSERT ─────────────────────────────────────────────────

  insert(data: any | any[], options?: { returning?: string; count?: string }): this {
    this.operation = 'insert';
    this.insertData = data;
    return this;
  }

  // ─── UPDATE ─────────────────────────────────────────────────

  update(data: any, options?: { returning?: string; count?: string }): this {
    this.operation = 'update';
    this.updateData = data;
    return this;
  }

  // ─── DELETE ─────────────────────────────────────────────────

  delete(options?: { returning?: string; count?: string }): this {
    this.operation = 'delete';
    return this;
  }

  // ─── UPSERT (simplified) ────────────────────────────────────

  upsert(data: any, options?: { onConflict?: string; count?: string }): this {
    this.operation = 'upsert';
    this.insertData = data;
    this.upsertConflict = options?.onConflict || null;
    return this;
  }

  // ─── THENABLE SUPPORT ──────────────────────────────────────
  // Makes the query builder directly awaitable.
  // Without this, `await db.from('users').select('*')` just returns
  // the builder object (not a PostgrestResult), causing ALL queries
  // to silently fail with data=undefined, error=undefined.
  //
  // With then(), JavaScript treats the builder as a "thenable" and
  // automatically calls then(resolve, reject) when awaited.

  then<TResult1 = PostgrestResult, TResult2 = never>(
    resolve?: (value: PostgrestResult) => TResult1 | PromiseLike<TResult1>,
    reject?: (reason: any) => TResult2 | PromiseLike<TResult2>
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(resolve, reject);
  }

  // ─── EXECUTE ────────────────────────────────────────────────

  async execute(): Promise<PostgrestResult> {
    try {
      switch (this.operation) {
        case 'select':
          return await this.executeSelect();
        case 'insert':
          return await this.executeInsert();
        case 'update':
          return await this.executeUpdate();
        case 'delete':
          return await this.executeDelete();
        case 'upsert':
          return await this.executeUpsert();
        default:
          // If no operation specified, default to select
          return await this.executeSelect();
      }
    } catch (error) {
      console.error(`[SupabaseWrapper] Error on ${this.tableName}:`, error);
      return {
        data: null,
        error: {
          message: error instanceof Error ? error.message : String(error),
          code: 'PGRST000',
        },
        count: null,
      };
    }
  }

  // ─── SELECT IMPLEMENTATION ─────────────────────────────────

  private async executeSelect(): Promise<PostgrestResult> {
    const model = (prisma as any)[this.modelName];
    if (!model) {
      return { data: null, error: { message: `Unknown model: ${this.modelName}`, code: 'PGRST001' }, count: null };
    }

    const where = this.buildWhereClause();

    // Build the Prisma query
    const query: Record<string, any> = { where };

    // CRITICAL PRISMA RULE: Cannot use both `select` and `include` at the same time.
    // When scalar fields are selected, ALL relations must be inside `select` too.
    // Only when there are NO scalar fields can we use `include` for relations.
    if (this.selectFields && Object.keys(this.selectFields).length > 0) {
      query.select = { ...this.selectFields };
      if (this.includeConfig && Object.keys(this.includeConfig).length > 0) {
        // All relations go INTO query.select (Prisma rule: no select + include together)
        Object.assign(query.select, this.includeConfig);
      }
    } else if (this.includeConfig && Object.keys(this.includeConfig).length > 0) {
      query.include = this.includeConfig;
    }

    // Ordering
    if (this.orderClauses.length > 0) {
      query.orderBy = this.orderClauses.map((oc) => ({
        [snakeToCamel(oc.column)]: oc.ascending ? 'asc' : 'desc',
      }));
    }

    // Pagination
    if (this.rangeFrom !== null && this.rangeTo !== null) {
      query.skip = this.rangeFrom;
      query.take = this.rangeTo - this.rangeFrom + 1;
    } else if (this.limitCount !== null) {
      query.take = this.limitCount;
    }

    // Count
    if (this.countMode === 'exact') {
      // Run count query separately
      const count = await model.count({ where });
      const results = await this.findResults(model, query);
      const snakeResults = toSnakeCaseDeep(results);
      // For single/maybeSingle, return single object (not array) to match real Supabase client
      if (this.singleMode) {
        return { data: snakeResults.length > 0 ? snakeResults[0] : null, error: null, count };
      }
      return { data: snakeResults, error: null, count };
    }

    // Head only (count without data)
    if (this.headOnly) {
      const count = await model.count({ where });
      return { data: null, error: null, count };
    }

    const results = await this.findResults(model, query);
    const snakeResults = toSnakeCaseDeep(results);
    // CRITICAL: For single/maybeSingle, return single object (not array)
    // to match real Supabase client behavior.
    // Without this, all auth (verifyAuthUser, login, me) breaks because
    // callers expect a single object, not [{ ... }].
    if (this.singleMode) {
      return { data: snakeResults.length > 0 ? snakeResults[0] : null, error: null, count: null };
    }
    return { data: snakeResults, error: null, count: null };
  }

  private async findResults(model: any, query: Record<string, any>): Promise<any[]> {
    if (this.singleMode === 'single') {
      const result = await model.findFirst(query);
      if (!result) {
        throw Object.assign(new Error('Results contain 0 rows'), { code: 'PGRST116', status: 406 });
      }
      return [result];
    }
    if (this.singleMode === 'maybeSingle') {
      const result = await model.findFirst(query);
      return result ? [result] : [];
    }
    return model.findMany(query);
  }

  // ─── UPSERT IMPLEMENTATION ─────────────────────────────────

  private async executeUpsert(): Promise<PostgrestResult> {
    const model = (prisma as any)[this.modelName];
    if (!model) {
      return { data: null, error: { message: `Unknown model: ${this.modelName}`, code: 'PGRST001' }, count: null };
    }

    const camelData = toCamelCaseDeep(this.insertData);
    const conflictFields = this.upsertConflict
      ? this.upsertConflict.split(',').map(f => snakeToCamel(f.trim()))
      : null;

    // Build include/select options from chained .select()
    const createOptions: Record<string, any> = {};
    if (this.selectFields && Object.keys(this.selectFields).length > 0) {
      createOptions.select = { ...this.selectFields };
      if (this.includeConfig && Object.keys(this.includeConfig).length > 0) {
        Object.assign(createOptions.select, this.includeConfig);
      }
    } else if (this.includeConfig && Object.keys(this.includeConfig).length > 0) {
      createOptions.include = this.includeConfig;
    }

    if (conflictFields && conflictFields.length > 0) {
      // Build where clause from conflict fields
      const whereClause: Record<string, any> = {};
      for (const field of conflictFields) {
        whereClause[field] = camelData[field];
      }

      // Use $transaction to prevent race condition on concurrent upserts
      const result = await prisma.$transaction(async (tx: any) => {
        const txModel = tx[this.modelName];
        const existing = await txModel.findFirst({ where: whereClause });

        if (existing) {
          const updateFields: Record<string, any> = { ...camelData };
          for (const field of conflictFields) delete updateFields[field];
          delete updateFields.id;
          delete updateFields.createdAt;
          for (const key of Object.keys(updateFields)) {
            if (updateFields[key] === undefined) delete updateFields[key];
          }
          return await txModel.update({
            where: { id: existing.id },
            data: updateFields,
            ...createOptions,
          });
        } else {
          return await txModel.create({ data: camelData, ...createOptions });
        }
      });

      return { data: toSnakeCaseDeep(result), error: null, count: 1 };
    } else {
      // No conflict fields — just insert (fallback)
      const result = await model.create({ data: camelData, ...createOptions });
      return { data: toSnakeCaseDeep(result), error: null, count: 1 };
    }
  }

  // ─── INSERT IMPLEMENTATION ─────────────────────────────────

  private async executeInsert(): Promise<PostgrestResult> {
    const model = (prisma as any)[this.modelName];
    if (!model) {
      return { data: null, error: { message: `Unknown model: ${this.modelName}`, code: 'PGRST001' }, count: null };
    }

    const dataArray = Array.isArray(this.insertData) ? this.insertData : [this.insertData];

    // Build Prisma create options (include/select from chained .select())
    const createOptions: Record<string, any> = {};
    if (this.includeConfig && Object.keys(this.includeConfig).length > 0) {
      createOptions.include = this.includeConfig;
    }

    if (dataArray.length === 1) {
      // Single insert
      const camelData = toCamelCaseDeep(dataArray[0]);
      const result = await model.create({ data: camelData, ...createOptions });
      return { data: toSnakeCaseDeep(result), error: null, count: null };
    }

    // Batch insert — use createMany for speed (no returning), fallback to individual for returning
    if (dataArray.length > 1 && !this.selectFields && !this.includeConfig) {
      // Fast path: batch insert without returning records
      const camelDataArray = dataArray.map(d => toCamelCaseDeep(d));
      const result = await model.createMany({ data: camelDataArray });
      return { data: null, error: null, count: result.count };
    }

    // Individual inserts (needed when .select() is chained after .insert())
    const results: any[] = [];
    for (const item of dataArray) {
      const camelData = toCamelCaseDeep(item);
      const result = await model.create({ data: camelData, ...createOptions });
      results.push(result);
    }
    return { data: toSnakeCaseDeep(results), error: null, count: results.length };
  }

  // ─── UPDATE IMPLEMENTATION ─────────────────────────────────

  private async executeUpdate(): Promise<PostgrestResult> {
    const model = (prisma as any)[this.modelName];
    if (!model) {
      return { data: null, error: { message: `Unknown model: ${this.modelName}`, code: 'PGRST001' }, count: null };
    }

    const where = this.buildWhereClause();
    const camelData = toCamelCaseDeep(this.updateData);

    // Remove undefined values to avoid Prisma errors
    for (const key of Object.keys(camelData)) {
      if (camelData[key] === undefined) {
        delete camelData[key];
      }
    }

    // Build select/include options from chained .select()
    const updateOptions: Record<string, any> = {};
    if (this.selectFields && Object.keys(this.selectFields).length > 0) {
      updateOptions.select = { ...this.selectFields };
      if (this.includeConfig && Object.keys(this.includeConfig).length > 0) {
        Object.assign(updateOptions.select, this.includeConfig);
      }
    } else if (this.includeConfig && Object.keys(this.includeConfig).length > 0) {
      updateOptions.include = this.includeConfig;
    }

    // Check if this is an update with eq filter on id (common pattern for single updates)
    const idFilter = this.filters.find(
      (f) => f.op === 'eq' && (f.field === 'id' || f.field === 'key')
    );

    // Case 1: Single filter on id/key, no select/singleMode → simple update()
    if (idFilter && this.filters.length === 1 && !this.singleMode) {
      const result = await model.update({
        where: { [snakeToCamel(idFilter.field)]: idFilter.value },
        data: camelData,
        ...updateOptions,
      });
      return { data: toSnakeCaseDeep(result), error: null, count: null };
    }

    // Case 2: Multi-filter update with select/singleMode — verify existence first, then update by id
    // This preserves the WHERE conditions as an optimistic lock while returning the updated record
    if (idFilter && (this.singleMode || (this.selectFields && Object.keys(this.selectFields).length > 0))) {
      // First check if a matching record exists (handles all filter conditions including optimistic locks)
      const existing = await model.findFirst({
        where,
        ...(updateOptions.select ? { select: updateOptions.select } : updateOptions.include ? { include: updateOptions.include } : {}),
      });
      if (!existing) {
        // No matching record — optimistic lock failed or record doesn't exist
        if (this.singleMode === 'single') {
          return { data: null, error: { message: 'Record not found or condition not met', code: 'PGRST116' }, count: 0 };
        }
        // maybeSingle: return null (not found is acceptable)
        return { data: null, error: null, count: 0 };
      }
      // Record exists — perform the update by id
      const result = await model.update({
        where: { id: idFilter.value },
        data: camelData,
        ...updateOptions,
      });
      return { data: toSnakeCaseDeep(result), error: null, count: 1 };
    }

    // Case 3: Multi-record updateMany (no select needed)
    const result = await model.updateMany({ where, data: camelData });
    return { data: null, error: null, count: result.count };
  }

  // ─── DELETE IMPLEMENTATION ─────────────────────────────────

  private async executeDelete(): Promise<PostgrestResult> {
    const model = (prisma as any)[this.modelName];
    if (!model) {
      return { data: null, error: { message: `Unknown model: ${this.modelName}`, code: 'PGRST001' }, count: null };
    }

    const where = this.buildWhereClause();

    // Build include options from chained .select()
    const deleteOptions: Record<string, any> = {};
    if (this.includeConfig && Object.keys(this.includeConfig).length > 0) {
      deleteOptions.include = this.includeConfig;
    }

    // Check if this is a delete with eq filter on id
    const idFilter = this.filters.find((f) => f.op === 'eq' && f.field === 'id');

    if (idFilter && this.filters.length === 1 && !this.singleMode) {
      // Use delete() for single record by id
      const result = await model.delete({
        where: { id: idFilter.value },
        ...deleteOptions,
      });
      return { data: toSnakeCaseDeep(result), error: null, count: null };
    }

    // Use deleteMany
    const result = await model.deleteMany({ where });
    return { data: null, error: null, count: result.count };
  }

  // ─── BUILD PRISMA WHERE CLAUSE FROM FILTERS ────────────────

  /**
   * Parse SQL LIKE pattern to Prisma string filter.
   * %test% → contains, test% → startsWith, %test → endsWith, test → equals
   */
  private parseLikePattern(pattern: string, caseInsensitive: boolean): Record<string, any> {
    const startsWithPercent = pattern.startsWith('%');
    const endsWithPercent = pattern.endsWith('%');
    const cleaned = pattern.replace(/^%|%$/g, '');
    const mode = caseInsensitive ? { mode: 'insensitive' as const } : {};

    if (startsWithPercent && endsWithPercent) {
      return { contains: cleaned, ...mode };
    } else if (startsWithPercent) {
      return { endsWith: cleaned, ...mode };
    } else if (endsWithPercent) {
      return { startsWith: cleaned, ...mode };
    } else {
      return { equals: cleaned, ...mode };
    }
  }

  private buildWhereClause(): Record<string, any> {
    const conditions: Record<string, any>[] = [];
    const allOrConditions: any[][] = []; // BUG 3 FIX: accumulate ALL OR blocks
    const allAndConditions: any[][] = []; // FIX: accumulate ALL AND blocks

    for (const filter of this.filters) {
      const camelField = snakeToCamel(filter.field);

      switch (filter.op) {
        case 'eq':
          conditions.push({ [camelField]: filter.value });
          break;
        case 'neq':
          conditions.push({ [camelField]: { not: filter.value } });
          break;
        case 'gt':
          conditions.push({ [camelField]: { gt: this.toPrismaValue(filter.value) } });
          break;
        case 'gte':
          conditions.push({ [camelField]: { gte: this.toPrismaValue(filter.value) } });
          break;
        case 'lt':
          conditions.push({ [camelField]: { lt: this.toPrismaValue(filter.value) } });
          break;
        case 'lte':
          conditions.push({ [camelField]: { lte: this.toPrismaValue(filter.value) } });
          break;
        case 'ilike': {
          conditions.push({ [camelField]: this.parseLikePattern(filter.value as string, true) });
          break;
        }
        case 'like': {
          conditions.push({ [camelField]: this.parseLikePattern(filter.value as string, false) });
          break;
        }
        case 'in':
          conditions.push({ [camelField]: { in: filter.value } });
          break;
        case 'is':
          if (filter.value === null) {
            conditions.push({ [camelField]: null });
          } else {
            conditions.push({ [camelField]: filter.value });
          }
          break;
        case 'not': {
          const { operator, value } = filter.value as { operator: string; value: any };
          const notCondition: Record<string, any> = {};
          switch (operator) {
            case 'eq':
              notCondition[camelField] = { not: value };
              break;
            case 'like':
            case 'ilike':
              notCondition[camelField] = { not: this.parseLikePattern(value as string, operator === 'ilike') };
              break;
            case 'in':
              notCondition[camelField] = { not: { in: value } };
              break;
            default:
              notCondition[camelField] = { not: value };
          }
          conditions.push(notCondition);
          break;
        }
        case 'or':
          allOrConditions.push(this.parseOrString(filter.value as string));
          break;
        case 'and':
          allAndConditions.push(this.parseOrString(filter.value as string));
          break;
      }
    }

    // Combine all conditions
    let where: Record<string, any> = {};
    if (conditions.length > 0) {
      where = conditions.length === 1 ? conditions[0] : { AND: conditions };
    }

    // Add OR conditions (flatten all accumulated OR blocks)
    if (allOrConditions.length > 0) {
      const flatOr = allOrConditions.flat();
      if (Object.keys(where).length > 0) {
        where = { AND: [where, { OR: flatOr }] };
      } else {
        where = { OR: flatOr };
      }
    }

    // Add AND conditions (flatten all accumulated AND blocks)
    if (allAndConditions.length > 0) {
      const flatAnd = allAndConditions.flat();
      if (Object.keys(where).length > 0) {
        where = { AND: [where, ...flatAnd] };
      } else {
        where = { AND: flatAnd };
      }
    }

    return where;
  }

  /**
   * Split a filter string by commas, respecting parentheses nesting.
   * e.g. "and(a.eq.1,b.eq.2),c.eq.3" → ["and(a.eq.1,b.eq.2)", "c.eq.3"]
   */
  private splitFilterParts(str: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let current = '';
    for (const char of str) {
      if (char === '(') depth++;
      else if (char === ')') depth--;
      if (char === ',' && depth === 0) {
        parts.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    if (current.trim()) parts.push(current);
    return parts;
  }

  /**
   * Parse a PostgREST filter string like "col1.eq.val1,col2.ilike.%val2%"
   * into Prisma where conditions.
   */
  private parseOrString(filterStr: string): any[] {
    // Split by comma, but respect parentheses (e.g. and(a.eq.1,b.eq.2),c.eq.3)
    const parts = this.splitFilterParts(filterStr);
    const conditions: any[] = [];

    for (const part of parts) {
      const trimmed = part.trim();

      // Handle and(...) and or(...) groups
      if (trimmed.startsWith('and(') && trimmed.endsWith(')')) {
        const inner = trimmed.slice(4, -1);
        const innerConditions = this.parseOrString(inner);
        if (innerConditions.length > 0) {
          conditions.push(innerConditions.length === 1 ? innerConditions[0] : { AND: innerConditions });
        }
        continue;
      }
      if (trimmed.startsWith('or(') && trimmed.endsWith(')')) {
        const inner = trimmed.slice(3, -1);
        const innerConditions = this.parseOrString(inner);
        if (innerConditions.length > 0) {
          conditions.push({ OR: innerConditions });
        }
        continue;
      }

      // Split by first dot: "column.operator.value"
      const firstDot = part.indexOf('.');
      if (firstDot === -1) continue;

      const column = part.substring(0, firstDot);
      const rest = part.substring(firstDot + 1);

      const secondDot = rest.indexOf('.');
      let operator: string;
      let value: string;

      if (secondDot === -1) {
        operator = rest;
        value = '';
      } else {
        operator = rest.substring(0, secondDot);
        value = rest.substring(secondDot + 1);
      }

      const camelField = snakeToCamel(column);

      switch (operator) {
        case 'eq':
          conditions.push({ [camelField]: this.parseFilterValue(value) });
          break;
        case 'neq':
          conditions.push({ [camelField]: { not: this.parseFilterValue(value) } });
          break;
        case 'gt':
          conditions.push({ [camelField]: { gt: this.toPrismaValue(this.parseFilterValue(value)) } });
          break;
        case 'gte':
          conditions.push({ [camelField]: { gte: this.toPrismaValue(this.parseFilterValue(value)) } });
          break;
        case 'lt':
          conditions.push({ [camelField]: { lt: this.toPrismaValue(this.parseFilterValue(value)) } });
          break;
        case 'lte':
          conditions.push({ [camelField]: { lte: this.toPrismaValue(this.parseFilterValue(value)) } });
          break;
        case 'like':
          conditions.push({ [camelField]: { contains: value.replace(/%/g, '') } });
          break;
        case 'ilike':
          conditions.push({ [camelField]: { contains: value.replace(/%/g, ''), mode: 'insensitive' } });
          break;
        case 'is':
          conditions.push({ [camelField]: value === 'null' ? null : value });
          break;
        case 'in': {
          // PostgREST in format: (val1,val2,val3) or val1.val2.val3
          const cleanVal = value.replace(/^\(|\)$/g, '');
          const vals = cleanVal.includes(',') 
            ? cleanVal.split(',').map((v) => this.parseFilterValue(v.trim()))
            : cleanVal.split('.').map((v) => this.parseFilterValue(v));
          conditions.push({ [camelField]: { in: vals } });
          break;
        }
        default:
          conditions.push({ [camelField]: this.parseFilterValue(value) });
      }
    }

    return conditions;
  }

  /** Parse a filter value string (handles null, booleans, numbers) */
  private parseFilterValue(value: string): any {
    if (value === 'null') return null;
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (value.startsWith('{') && value.endsWith('}')) {
      // Try JSON parse
      try { return JSON.parse(value); } catch { return value; }
    }
    // Try numeric
    const num = Number(value);
    if (!isNaN(num) && value !== '') return num;
    return value;
  }

  /** Convert a value for Prisma comparison (handle date strings) */
  private toPrismaValue(value: any): any {
    if (typeof value === 'string') {
      // Try to parse as date
      const asDate = new Date(value);
      if (!isNaN(asDate.getTime()) && value.includes('T')) {
        return asDate;
      }
    }
    return value;
  }
}

// ─────────────────────────────────────────────────────────────────────
// MAIN CLIENT OBJECT
// ─────────────────────────────────────────────────────────────────────

/**
 * Main database client — PostgREST-compatible API backed by Prisma/Supabase PostgreSQL.
 *
 * Usage (identical to Supabase):
 *   db.from('users').select('*').eq('id', '123')
 *   db.from('products').insert({ name: 'Test' }).select()
 *   db.from('transactions').update({ status: 'approved' }).eq('id', 'abc')
 *   db.from('logs').delete().eq('id', 'xyz')
 *   db.rpc('function_name', { params })
 */
const dbClient = {
  from(tableName: string): PostgrestQueryBuilder {
    return new PostgrestQueryBuilder(tableName);
  },

  async rpc(fnName: string, params: Record<string, any> = {}): Promise<PostgrestResult> {
    // Delegate to Prisma-based RPC implementations
    const { rpcHandlers } = await import('./rpc-impl');
    const handler = rpcHandlers[fnName];
    if (!handler) {
      console.warn(`[SupabaseWrapper] Unknown RPC: ${fnName}`);
      return {
        data: null,
        error: { message: `Unknown RPC function: ${fnName}`, code: 'PGRST301' },
        count: null,
      };
    }
    const result = await handler(params);
    return { ...result, count: null };
  },

  // Auth/Storage/Realtime stubs (for backward compatibility)
  auth: null,
  storage: null,
  channel: () => null,
  removeChannel: () => {},
  removeAllChannels: () => {},
  get tableNameMap() {
    return TABLE_TO_MODEL;
  },
};

export const supabaseAdmin = dbClient;
export const db = dbClient;
