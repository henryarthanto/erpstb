// =====================================================================
// FINANCE ENGINE — Stub (PostgreSQL RPC functions migrated to Prisma)
//
// The banking-grade ledger system previously used PostgreSQL RPC functions
// (atomic_double_entry, etc.) for double-entry bookkeeping with atomic
// transaction guarantees.
//
// This stub preserves the API surface while logging warnings. The
// double-entry functionality will be reimplemented using Prisma $transaction.
//
// TODO: Reimplement with Prisma interactive transactions for atomicity.
// =====================================================================

import { db } from '@/lib/supabase';
import { generateId } from '@/lib/supabase-helpers';
import { atomicUpdatePoolBalance, atomicUpdateBalance, getPoolBalance } from '@/lib/atomic-ops';

export interface LedgerEntry {
  journalId: string;
  accountType: 'pool' | 'bank' | 'cashbox';
  accountKey: string;
  delta: number;
  balanceBefore: number;
  balanceAfter: number;
  referenceType: string;
  referenceId?: string;
  description?: string;
  createdBy?: string;
}

export type AccountType = 'pool' | 'bank' | 'cashbox';
export type PhysicalTable = 'bank_accounts' | 'cash_boxes';

const POOL_LABELS: Record<string, string> = {
  pool_hpp_paid_balance: 'HPP Sudah Terbayar',
  pool_profit_paid_balance: 'Profit Sudah Terbayar',
  pool_investor_fund: 'Dana Lain-lain',
};

function getPoolLabel(poolKey: string): string {
  return POOL_LABELS[poolKey] || poolKey;
}

async function getCurrentBalance(accountType: AccountType, accountKey: string): Promise<number> {
  if (accountType === 'pool') {
    return getPoolBalance(accountKey);
  }
  const table = accountType === 'bank' ? 'bank_accounts' : 'cash_boxes';
  const { data } = await db.from(table).select('balance').eq('id', accountKey).maybeSingle();
  return Number(data?.balance) || 0;
}

async function writeLedgerEntry(entry: LedgerEntry): Promise<void> {
  try {
    await db.from('finance_ledger').insert({
      id: generateId(),
      journal_id: entry.journalId,
      account_type: entry.accountType,
      account_key: entry.accountKey,
      delta: entry.delta,
      balance_before: entry.balanceBefore,
      balance_after: entry.balanceAfter,
      reference_type: entry.referenceType,
      reference_id: entry.referenceId || null,
      description: entry.description || null,
      created_by_id: entry.createdBy || null,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[FinanceEngine] Failed to write ledger entry:', err instanceof Error ? err.message : String(err));
  }
}

async function creditPool(poolKey: string, amount: number, journalId: string, referenceType: string, referenceId: string, description: string, createdBy?: string, minBalance = 0): Promise<number> {
  const balanceBefore = await getPoolBalance(poolKey);
  const newBalance = await atomicUpdatePoolBalance(poolKey, amount, minBalance);
  await writeLedgerEntry({ journalId, accountType: 'pool', accountKey: poolKey, delta: Math.round(amount), balanceBefore: Math.round(balanceBefore), balanceAfter: Math.round(newBalance), referenceType, referenceId, description, createdBy });
  return newBalance;
}

async function debitPool(poolKey: string, amount: number, journalId: string, referenceType: string, referenceId: string, description: string, createdBy?: string, minBalance = 0): Promise<number> {
  const balanceBefore = await getPoolBalance(poolKey);
  const newBalance = await atomicUpdatePoolBalance(poolKey, -amount, minBalance);
  await writeLedgerEntry({ journalId, accountType: 'pool', accountKey: poolKey, delta: -Math.round(amount), balanceBefore: Math.round(balanceBefore), balanceAfter: Math.round(newBalance), referenceType, referenceId, description, createdBy });
  return newBalance;
}

async function creditPhysical(table: PhysicalTable, accountId: string, amount: number, journalId: string, referenceType: string, referenceId: string, description: string, createdBy?: string, minBalance = 0): Promise<number> {
  const accountType: AccountType = table === 'bank_accounts' ? 'bank' : 'cashbox';
  const balanceBefore = await getCurrentBalance(accountType, accountId);
  const newBalance = await atomicUpdateBalance(table, accountId, amount, minBalance);
  await writeLedgerEntry({ journalId, accountType, accountKey: accountId, delta: Math.round(amount), balanceBefore: Math.round(balanceBefore), balanceAfter: Math.round(newBalance), referenceType, referenceId, description, createdBy });
  return newBalance;
}

async function debitPhysical(table: PhysicalTable, accountId: string, amount: number, journalId: string, referenceType: string, referenceId: string, description: string, createdBy?: string, minBalance = 0): Promise<number> {
  const accountType: AccountType = table === 'bank_accounts' ? 'bank' : 'cashbox';
  const balanceBefore = await getCurrentBalance(accountType, accountId);
  const newBalance = await atomicUpdateBalance(table, accountId, -amount, minBalance);
  await writeLedgerEntry({ journalId, accountType, accountKey: accountId, delta: -Math.round(amount), balanceBefore: Math.round(balanceBefore), balanceAfter: Math.round(newBalance), referenceType, referenceId, description, createdBy });
  return newBalance;
}

async function doubleEntry(
  debit: { type: 'pool'; key: string } | { type: 'physical'; table: PhysicalTable; id: string },
  credit: { type: 'pool'; key: string } | { type: 'physical'; table: PhysicalTable; id: string },
  amount: number,
  journalId: string,
  referenceType: string,
  referenceId: string,
  description: string,
  createdBy?: string,
  minBalance = 0,
): Promise<{ debitResult: number; creditResult: number }> {
  // Sequential fallback (no atomic RPC in MariaDB mode)
  console.warn('[FinanceEngine] doubleEntry using sequential fallback (no atomic RPC in MariaDB mode)');

  const debitDesc = debit.type === 'pool'
    ? `${description} (Debit: ${getPoolLabel(debit.key)})`
    : `${description} (Debit)`;
  const creditDesc = credit.type === 'pool'
    ? `${description} (Credit: ${getPoolLabel(credit.key)})`
    : `${description} (Credit)`;

  let debitResult: number;
  try {
    if (debit.type === 'pool') {
      debitResult = await debitPool(debit.key, amount, journalId, referenceType, referenceId, debitDesc, createdBy, minBalance);
    } else {
      debitResult = await debitPhysical(debit.table, debit.id, amount, journalId, referenceType, referenceId, debitDesc, createdBy, minBalance);
    }
  } catch (debitErr) {
    throw debitErr;
  }

  let creditResult: number;
  try {
    if (credit.type === 'pool') {
      creditResult = await creditPool(credit.key, amount, journalId, referenceType, referenceId, creditDesc, createdBy, minBalance);
    } else {
      creditResult = await creditPhysical(credit.table, credit.id, amount, journalId, referenceType, referenceId, creditDesc, createdBy, minBalance);
    }
  } catch (creditErr) {
    // Compensating rollback
    console.error('[FinanceEngine] doubleEntry credit failed, performing compensating rollback');
    try {
      if (debit.type === 'pool') {
        await atomicUpdatePoolBalance(debit.key, amount, 0);
      } else {
        await atomicUpdateBalance(debit.table, debit.id, amount, 0);
      }
    } catch (rollbackErr) {
      console.error('[FinanceEngine] CRITICAL: Compensating rollback failed!', rollbackErr);
    }
    throw creditErr;
  }

  return { debitResult, creditResult };
}

async function transferPhysical(
  fromTable: PhysicalTable,
  fromId: string,
  toTable: PhysicalTable,
  toId: string,
  amount: number,
  journalId: string,
  referenceType: string,
  referenceId: string,
  description: string,
  createdBy?: string,
): Promise<{ fromBalance: number; toBalance: number }> {
  let fromBalance: number;
  try {
    fromBalance = await debitPhysical(fromTable, fromId, amount, journalId, referenceType, referenceId, `${description} (Keluar)`, createdBy);
  } catch (debitErr) {
    throw debitErr;
  }

  let toBalance: number;
  try {
    toBalance = await creditPhysical(toTable, toId, amount, journalId, referenceType, referenceId, `${description} (Masuk)`, createdBy);
  } catch (creditErr) {
    console.error('[FinanceEngine] transferPhysical credit failed, performing compensating rollback');
    try {
      await atomicUpdateBalance(fromTable, fromId, amount, 0);
    } catch (rollbackErr) {
      console.error('[FinanceEngine] CRITICAL: Compensating rollback failed!', rollbackErr);
    }
    throw creditErr;
  }

  return { fromBalance, toBalance };
}

async function getDerivedPoolBalances(): Promise<Record<string, number>> {
  const { data, error } = await db.from('finance_ledger').select('account_key, delta').eq('account_type', 'pool');
  if (error) {
    console.error('[FinanceEngine] Failed to derive pool balances:', error);
    return {};
  }
  const balances: Record<string, number> = {};
  for (const entry of (data || [])) {
    const key = entry.account_key;
    balances[key] = (balances[key] || 0) + (Number(entry.delta) || 0);
  }
  for (const key of Object.keys(balances)) balances[key] = Math.round(balances[key]);
  return balances;
}

async function getDerivedPhysicalBalances(): Promise<{ bank: Record<string, number>; cashbox: Record<string, number> }> {
  const { data, error } = await db.from('finance_ledger').select('account_type, account_key, delta').neq('account_type', 'pool');
  if (error) {
    console.error('[FinanceEngine] Failed to derive physical balances:', error);
    return { bank: {}, cashbox: {} };
  }
  const bankBalances: Record<string, number> = {};
  const cashboxBalances: Record<string, number> = {};
  for (const entry of (data || [])) {
    const key = entry.account_key;
    const delta = Number(entry.delta) || 0;
    if (entry.account_type === 'bank') bankBalances[key] = (bankBalances[key] || 0) + delta;
    else if (entry.account_type === 'cashbox') cashboxBalances[key] = (cashboxBalances[key] || 0) + delta;
  }
  for (const key of Object.keys(bankBalances)) bankBalances[key] = Math.round(bankBalances[key]);
  for (const key of Object.keys(cashboxBalances)) cashboxBalances[key] = Math.round(cashboxBalances[key]);
  return { bank: bankBalances, cashbox: cashboxBalances };
}

async function reconcile(): Promise<{
  isHealthy: boolean;
  issues: Array<{ type: string; account: string; ledger: number; actual: number; diff: number }>;
  poolComparison: Record<string, { ledger: number; actual: number; diff: number }>;
}> {
  const issues: Array<{ type: string; account: string; ledger: number; actual: number; diff: number }> = [];
  const poolComparison: Record<string, { ledger: number; actual: number; diff: number }> = {};

  const derivedPools = await getDerivedPoolBalances();
  const poolKeys = ['pool_hpp_paid_balance', 'pool_profit_paid_balance', 'pool_investor_fund'];
  for (const key of poolKeys) {
    const ledgerBalance = derivedPools[key] || 0;
    const actualBalance = await getPoolBalance(key);
    const diff = actualBalance - ledgerBalance;
    poolComparison[key] = { ledger: ledgerBalance, actual: actualBalance, diff: Math.round(diff) };
    if (Math.abs(diff) > 0.01) {
      issues.push({ type: 'pool_drift', account: getPoolLabel(key), ledger: ledgerBalance, actual: actualBalance, diff: Math.round(diff) });
    }
  }

  const derivedPhysical = await getDerivedPhysicalBalances();
  const { data: bankAccounts } = await db.from('bank_accounts').select('id, name, balance').eq('is_active', true);
  for (const ba of (bankAccounts || [])) {
    const ledgerBal = derivedPhysical.bank[ba.id] || 0;
    const actualBal = Number(ba.balance) || 0;
    const diff = actualBal - ledgerBal;
    if (Math.abs(diff) > 0.01) {
      issues.push({ type: 'bank_drift', account: `${ba.name} (${ba.id.slice(0, 8)})`, ledger: ledgerBal, actual: actualBal, diff: Math.round(diff) });
    }
  }

  const { data: cashBoxes } = await db.from('cash_boxes').select('id, name, balance').eq('is_active', true);
  for (const cb of (cashBoxes || [])) {
    const ledgerBal = derivedPhysical.cashbox[cb.id] || 0;
    const actualBal = Number(cb.balance) || 0;
    const diff = actualBal - ledgerBal;
    if (Math.abs(diff) > 0.01) {
      issues.push({ type: 'cashbox_drift', account: `${cb.name} (${cb.id.slice(0, 8)})`, ledger: ledgerBal, actual: actualBal, diff: Math.round(diff) });
    }
  }

  return { isHealthy: issues.length === 0, issues, poolComparison };
}

export const financeEngine = {
  creditPool,
  debitPool,
  creditPhysical,
  debitPhysical,
  doubleEntry,
  transferPhysical,
  getPoolLabel,
  writeLedgerEntry,
  getCurrentBalance,
  getDerivedPoolBalances,
  getDerivedPhysicalBalances,
  reconcile,
};
