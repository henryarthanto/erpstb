import { NextRequest, NextResponse } from 'next/server';
import { verifyAndGetAuthUser } from '@/lib/token';
import { db } from '@/lib/supabase';
import { generateId } from '@/lib/supabase-helpers';
import { atomicUpdateBalance } from '@/lib/atomic-ops';
import { wsTransactionUpdate, wsFinanceUpdate } from '@/lib/ws-dispatch';
import { cacheInvalidatePrefix } from '@/lib/redis-cache';

// In-memory set to prevent duplicate mutation matches (resets on server restart — good enough for single-instance)
const _matchedMutations = new Set<string>();
const MAX_MATCHED_CACHE = 10000;

function isAlreadyMatched(mutationId: string): boolean {
  return _matchedMutations.has(mutationId);
}

function markAsMatched(mutationId: string): void {
  _matchedMutations.add(mutationId);
  // Prevent unbounded growth
  if (_matchedMutations.size > MAX_MATCHED_CACHE) {
    const iter = _matchedMutations.values();
    for (let i = 0; i < MAX_MATCHED_CACHE / 2; i++) {
      _matchedMutations.delete(iter.next().value!);
    }
  }
}

/**
 * POST /api/finance/moota/match
 * 
 * Match a bank mutation to an action:
 * - type: "lunas" — Mark an invoice as paid (create payment)
 * - type: "pool" — Add funds to pool dana
 * - type: "expense" — Record as expense
 * - type: "salary" — Record as salary payment
 * - type: "purchase" — Record as purchase/hutang
 */
export async function POST(request: NextRequest) {
  try {
    const authResult = await verifyAndGetAuthUser(request.headers.get('authorization'), { role: true });
    if (!authResult || !['super_admin', 'keuangan'].includes(authResult.user.role)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { type, mutationId, mutationAmount, mutationDate, mutationDescription, bankAccountId, bankId } = body;

    if (!type || !mutationAmount) {
      return NextResponse.json({ error: 'type dan mutationAmount diperlukan' }, { status: 400 });
    }

    // Idempotency check — prevent double-processing the same mutation
    if (mutationId && isAlreadyMatched(mutationId)) {
      return NextResponse.json({ error: 'Mutasi sudah pernah diproses', alreadyMatched: true }, { status: 409 });
    }

    const amount = Math.abs(Number(mutationAmount));
    const userId = authResult.userId;

    switch (type) {
      case 'lunas': {
        // Mark invoice as lunas
        const { transactionId } = body;
        if (!transactionId) {
          return NextResponse.json({ error: 'transactionId diperlukan' }, { status: 400 });
        }

        // Get transaction
        const { data: tx, error: txError } = await db
          .from('transactions')
          .select('*')
          .eq('id', transactionId)
          .single();

        if (txError || !tx) {
          return NextResponse.json({ error: 'Transaksi tidak ditemukan' }, { status: 404 });
        }

        const remaining = Math.max(0, Number(tx.remaining_amount) - amount);
        const newPaid = Number(tx.paid_amount) + amount;
        const isLunas = remaining <= 0;

        // Update transaction
        const { error: updateError } = await db
          .from('transactions')
          .update({
            paid_amount: newPaid,
            remaining_amount: remaining,
            payment_status: isLunas ? 'paid' : 'partial',
            updated_at: new Date().toISOString(),
          })
          .eq('id', transactionId);

        if (updateError) throw updateError;

        // Create payment record
        const paymentId = generateId();
        const { error: paymentError } = await db.from('payments').insert({
          id: paymentId,
          transaction_id: transactionId,
          received_by_id: userId,
          amount,
          paymentMethod: 'transfer',
          bank_account_id: bankAccountId || null,
          notes: `Dari mutasi bank Moota — ${mutationDescription || mutationDate || ''}`,
          version: 1,
          paid_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
        });

        if (paymentError) {
          console.error('[Moota Match] Error creating payment:', paymentError);
          throw new Error('Gagal membuat record pembayaran');
        }

        // Update bank account balance if bankAccountId provided
        if (bankAccountId) {
          try {
            await atomicUpdateBalance('bank_accounts', bankAccountId, amount);
          } catch (err) {
            console.error('[Moota Match] Error updating bank balance:', err);
          }
        }

        markAsMatched(mutationId);
        wsTransactionUpdate({ transactionId, type: 'payment', amount });
        wsFinanceUpdate({ type: 'payment', amount });
        cacheInvalidatePrefix('api:cashflow:').catch(() => {});
        cacheInvalidatePrefix('api:transactions:').catch(() => {});

        return NextResponse.json({
          success: true,
          message: isLunas ? 'Invoice berhasil ditandai LUNAS!' : `Pembayaran tercatat. Sisa: ${remaining.toLocaleString('id-ID')}`,
          isLunas,
          remaining,
        });
      }

      case 'pool': {
        // Add to pool dana
        const { poolKey } = body; // e.g., 'pool_hpp_paid_balance', 'pool_profit_paid_balance'
        if (!poolKey) {
          return NextResponse.json({ error: 'poolKey diperlukan (pool_hpp_paid_balance / pool_profit_paid_balance)' }, { status: 400 });
        }

        const poolDescription = body.description || mutationDescription || '';
        const poolNow = new Date().toISOString();
        const poolDate = mutationDate ? new Date(mutationDate).toISOString() : poolNow;

        // Update bank balance
        if (bankAccountId) {
          try {
            await atomicUpdateBalance('bank_accounts', bankAccountId, amount);
          } catch (err) {
            console.error('[Moota Match] Error updating bank balance:', err);
          }
        }

        // Update pool via atomic setting balance
        const { error: poolError } = await db.rpc('atomic_update_setting_balance', {
          p_key: poolKey,
          p_delta: amount,
          p_min: 0,
        });

        if (poolError) throw poolError;

        // Create finance_request so pool deposits are visible in cash flow (arus kas)
        const poolRequestId = generateId();
        const { error: poolFreqError } = await db.from('finance_requests').insert({
          id: poolRequestId,
          type: 'expense',
          description: `Setor dana ke pool dari mutasi bank — ${poolDescription}`,
          status: 'processed',
          payment_type: 'pay_now',
          bank_account_id: bankAccountId || null,
          fund_source: poolKey,
          processed_by_id: userId,
          created_by_id: userId,
          processed_at: poolDate,
          created_at: poolNow,
        });

        if (poolFreqError) {
          console.error('[Moota Match] Warning: Failed to create finance_request for pool deposit:', poolFreqError);
          // Non-fatal — pool balance is already updated
        }

        markAsMatched(mutationId);
        wsFinanceUpdate({ type: 'pool_deposit', poolKey, amount });
        cacheInvalidatePrefix('api:cashflow:').catch(() => {});

        return NextResponse.json({
          success: true,
          message: `Dana ${poolKey.includes('hpp') ? 'HPP' : 'Profit'} berhasil ditambah ${amount.toLocaleString('id-ID')}`,
        });
      }

      case 'expense': {
        // Record as expense — only create finance_request (not expenses table) to avoid double counting in cash flow
        const { description } = body;
        const now = new Date().toISOString();
        const expenseDate = mutationDate ? new Date(mutationDate).toISOString() : now;

        // Deduct from bank account
        if (bankAccountId) {
          try {
            await atomicUpdateBalance('bank_accounts', bankAccountId, -amount);
          } catch (err) {
            return NextResponse.json({ error: `Saldo bank tidak mencukupi: ${err}` }, { status: 400 });
          }
        }

        // Create finance_request — this is the single source of truth for cash flow
        const expRequestId = generateId();
        const { error: freqError } = await db.from('finance_requests').insert({
          id: expRequestId,
          type: 'expense',
          amount,
          description: description || `Pengeluaran dari mutasi bank — ${mutationDescription || ''}`,
          source_type: 'bank',
          bank_account_id: bankAccountId || null,
          status: 'processed',
          payment_type: 'pay_now',
          processed_by_id: userId,
          created_by_id: userId,
          processed_at: expenseDate,
          created_at: now,
        });

        if (freqError) {
          // If finance_request creation fails but bank balance was deducted, re-add the balance
          if (bankAccountId) {
            try {
              await atomicUpdateBalance('bank_accounts', bankAccountId, amount);
            } catch (rollbackErr) {
              console.error('[Moota Match] CRITICAL: Failed to rollback bank balance after expense error:', rollbackErr);
            }
          }
          throw new Error(`Gagal mencatat pengeluaran: ${freqError.message}`);
        }

        markAsMatched(mutationId);
        wsFinanceUpdate({ type: 'expense', amount });
        cacheInvalidatePrefix('api:cashflow:').catch(() => {});

        return NextResponse.json({
          success: true,
          message: `Pengeluaran Rp ${amount.toLocaleString('id-ID')} berhasil dicatat`,
        });
      }

      case 'salary': {
        // Record as salary payment
        const { targetUserId } = body;
        const now = new Date().toISOString();

        if (bankAccountId) {
          try {
            await atomicUpdateBalance('bank_accounts', bankAccountId, -amount);
          } catch (err) {
            return NextResponse.json({ error: `Saldo bank tidak mencukupi: ${err}` }, { status: 400 });
          }
        }

        // Create a finance request with type 'salary'
        const requestId = generateId();
        const { error: reqError } = await db.from('finance_requests').insert({
          id: requestId,
          type: 'salary',
          amount,
          description: `Pembayaran gaji dari mutasi bank — ${mutationDescription || ''}`,
          source_type: 'bank',
          bank_account_id: bankAccountId || null,
          status: 'processed',
          payment_type: 'pay_now',
          processed_by_id: userId,
          created_by_id: userId,
          processed_at: mutationDate ? new Date(mutationDate).toISOString() : now,
          created_at: now,
        });

        if (reqError) {
          // Rollback bank balance if request creation fails
          if (bankAccountId) {
            try {
              await atomicUpdateBalance('bank_accounts', bankAccountId, amount);
            } catch (rollbackErr) {
              console.error('[Moota Match] CRITICAL: Failed to rollback bank balance after salary error:', rollbackErr);
            }
          }
          throw new Error(`Gagal mencatat pembayaran gaji: ${reqError.message}`);
        }

        markAsMatched(mutationId);
        wsFinanceUpdate({ type: 'salary', amount });
        cacheInvalidatePrefix('api:cashflow:').catch(() => {});

        return NextResponse.json({
          success: true,
          message: `Pembayaran gaji Rp ${amount.toLocaleString('id-ID')} berhasil dicatat`,
        });
      }

      case 'purchase': {
        // Record as purchase / hutang (pembelian)
        const { description, supplierId, categoryId } = body;
        const now = new Date().toISOString();
        const purchaseDate = mutationDate ? new Date(mutationDate).toISOString() : now;

        if (bankAccountId) {
          try {
            await atomicUpdateBalance('bank_accounts', bankAccountId, -amount);
          } catch (err) {
            return NextResponse.json({ error: `Saldo bank tidak mencukupi: ${err}` }, { status: 400 });
          }
        }

        // Record as a finance request with type 'purchase'
        const purchaseId = generateId();
        const { error: purchaseError } = await db.from('finance_requests').insert({
          id: purchaseId,
          type: 'purchase',
          amount,
          description: description || `Pembelian dari mutasi bank — ${mutationDescription || ''}`,
          source_type: 'bank',
          bank_account_id: bankAccountId || null,
          status: 'processed',
          payment_type: 'pay_now',
          processed_by_id: userId,
          created_by_id: userId,
          processed_at: purchaseDate,
          created_at: now,
        });

        if (purchaseError) {
          // Rollback bank balance
          if (bankAccountId) {
            try {
              await atomicUpdateBalance('bank_accounts', bankAccountId, amount);
            } catch (rollbackErr) {
              console.error('[Moota Match] CRITICAL: Failed to rollback bank balance after purchase error:', rollbackErr);
            }
          }
          throw new Error(`Gagal mencatat pembelian: ${purchaseError.message}`);
        }

        markAsMatched(mutationId);
        wsFinanceUpdate({ type: 'purchase', amount });
        cacheInvalidatePrefix('api:cashflow:').catch(() => {});

        return NextResponse.json({
          success: true,
          message: `Pembelian Rp ${amount.toLocaleString('id-ID')} berhasil dicatat`,
        });
      }

      default:
        return NextResponse.json({ error: `Tipe action tidak dikenali: ${type}` }, { status: 400 });
    }
  } catch (error) {
    console.error('[Moota Match] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Terjadi kesalahan server' },
      { status: 500 }
    );
  }
}
