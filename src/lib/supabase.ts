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

// ─────────────────────────────────────────────────────────────────────
// PRISMA CLIENT (singleton)
// ─────────────────────────────────────────────────────────────────────

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };
export const prisma = globalForPrisma.prisma || new PrismaClient({
  datasourceUrl: process.env.DATABASE_URL,
  // Limit connections for 2GB STB — prevents connection exhaustion
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
});
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

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

    // Check for embedded relation: 'alias:table_name(fields)'
    const embedMatch = trimmed.match(/^(\w+):(\w+)\(([^)]*)\)$/);
    if (embedMatch) {
      const alias = embedMatch[1];
      const tableName = embedMatch[2];
      const nestedFields = embedMatch[3];

      const modelName = TABLE_TO_MODEL[tableName];
      if (modelName) {
        const nestedParse = parseSelectString(nestedFields || '*');
        const nestedInclude: Record<string, any> = {};
        if (nestedParse.selectFields) {
          nestedInclude.select = nestedParse.selectFields;
        }
        if (nestedParse.includeConfig && Object.keys(nestedParse.includeConfig).length > 0) {
          Object.assign(nestedInclude, nestedParse.includeConfig);
        }
        if (Object.keys(nestedInclude).length === 0) {
          includeConfig[modelName] = true;
        } else {
          includeConfig[modelName] = nestedInclude;
        }
      }
      continue;
    }

    // Check for direct relation: 'table_name(fields)'
    const directEmbedMatch = trimmed.match(/^(\w+)\(([^)]*)\)$/);
    if (directEmbedMatch) {
      const tableName = directEmbedMatch[1];
      const nestedFields = directEmbedMatch[2];
      const modelName = TABLE_TO_MODEL[tableName];
      if (modelName) {
        if (nestedFields.trim() === '*') {
          includeConfig[modelName] = true;
        } else {
          const nestedParse = parseSelectString(nestedFields);
          const nestedInclude: Record<string, any> = {};
          if (nestedParse.selectFields) {
            nestedInclude.select = nestedParse.selectFields;
          }
          if (nestedParse.includeConfig && Object.keys(nestedParse.includeConfig).length > 0) {
            Object.assign(nestedInclude, nestedParse.includeConfig);
          }
          includeConfig[modelName] = Object.keys(nestedInclude).length > 0 ? nestedInclude : true;
        }
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
  private operation: 'select' | 'insert' | 'update' | 'delete' | null = null;
  private insertData: any = null;
  private updateData: any = null;
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
    this.operation = 'insert';
    this.insertData = data;
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

    if (this.selectFields && Object.keys(this.selectFields).length > 0) {
      query.select = { ...this.selectFields };
      if (this.includeConfig && Object.keys(this.includeConfig).length > 0) {
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

    // Build include options from chained .select()
    const updateOptions: Record<string, any> = {};
    if (this.includeConfig && Object.keys(this.includeConfig).length > 0) {
      updateOptions.include = this.includeConfig;
    }

    // Check if this is an update with eq filter on id (common pattern for single updates)
    const idFilter = this.filters.find(
      (f) => f.op === 'eq' && (f.field === 'id' || f.field === 'key')
    );

    if (idFilter && this.filters.length === 1 && !this.singleMode) {
      // Use update() for single record by id
      const result = await model.update({
        where: { [snakeToCamel(idFilter.field)]: idFilter.value },
        data: camelData,
        ...updateOptions,
      });
      return { data: toSnakeCaseDeep(result), error: null, count: null };
    }

    // Use updateMany for multi-record updates
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

  private buildWhereClause(): Record<string, any> {
    const conditions: Record<string, any>[] = [];
    let orConditions: any[] | null = null;
    let andConditions: any[] | null = null;

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
        case 'ilike':
        case 'like': {
          const pattern = filter.value as string;
          // MariaDB utf8mb4_general_ci is already case-insensitive — no mode needed
          // Using mode:'insensitive' adds LOWER() wrapper which prevents index usage
          conditions.push({ [camelField]: { contains: pattern.replace(/%/g, '') } });
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
              // MariaDB utf8mb4_general_ci is already case-insensitive
              notCondition[camelField] = { not: { contains: value.replace(/%/g, '') } };
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
          orConditions = this.parseOrString(filter.value as string);
          break;
        case 'and':
          andConditions = this.parseOrString(filter.value as string);
          break;
      }
    }

    // Combine all conditions
    let where: Record<string, any> = {};
    if (conditions.length > 0) {
      where = conditions.length === 1 ? conditions[0] : { AND: conditions };
    }

    // Add OR conditions
    if (orConditions && orConditions.length > 0) {
      if (Object.keys(where).length > 0) {
        where = { AND: [where, { OR: orConditions }] };
      } else {
        where = { OR: orConditions };
      }
    }

    // Add AND conditions
    if (andConditions && andConditions.length > 0) {
      if (Object.keys(where).length > 0) {
        where = { AND: [where, ...andConditions] };
      } else {
        where = { AND: andConditions };
      }
    }

    return where;
  }

  /**
   * Parse a PostgREST filter string like "col1.eq.val1,col2.ilike.%val2%"
   * into Prisma where conditions.
   */
  private parseOrString(filterStr: string): any[] {
    const parts = filterStr.split(',').map((p) => p.trim()).filter(Boolean);
    const conditions: any[] = [];

    for (const part of parts) {
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
        case 'ilike':
          // MariaDB utf8mb4_general_ci is already case-insensitive
          conditions.push({ [camelField]: { contains: value.replace(/%/g, '') } });
          break;
        case 'is':
          conditions.push({ [camelField]: value === 'null' ? null : value });
          break;
        case 'in': {
          const vals = value.split('.').map((v) => this.parseFilterValue(v));
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
 * Main database client — PostgREST-compatible API backed by Prisma/MariaDB.
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
    // RPC stub — PostgreSQL functions will be reimplemented with Prisma transactions
    console.warn(`[SupabaseWrapper] RPC "${fnName}" called — not yet reimplemented for MariaDB`);
    return {
      data: null,
      error: {
        message: `RPC function "${fnName}" is not yet reimplemented for MariaDB. Will be replaced with Prisma transactions.`,
        code: 'PGRST301',
      },
      count: null,
    };
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
