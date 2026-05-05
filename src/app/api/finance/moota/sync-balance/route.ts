import { NextRequest, NextResponse } from 'next/server';
import { getMootaBanks, getMootaMutations, isMootaConfigured } from '@/lib/moota';
import { verifyAndGetAuthUser } from '@/lib/token';
import { db } from '@/lib/supabase';

/**
 * POST /api/finance/moota/sync-balance
 *
 * Sync bank balances from Moota to internal bank_accounts table.
 * Matches by account_number and sets balance to Moota's reported balance.
 *
 * Optional body:
 *   { bankId: "moota_bank_id" } — sync only one bank (default: sync all)
 */
export async function POST(request: NextRequest) {
  try {
    const authResult = await verifyAndGetAuthUser(request.headers.get('authorization'), { role: true });
    if (!authResult || !['super_admin', 'keuangan'].includes(authResult.user.role)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!isMootaConfigured()) {
      return NextResponse.json(
        { error: 'Moota API belum dikonfigurasi. Tambahkan MOOTA_PERSONAL_TOKEN di .env.local' },
        { status: 400 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const { bankId: targetBankId } = body;

    // Fetch banks from Moota
    const mootaBanks = await getMootaBanks();

    if (!mootaBanks || mootaBanks.length === 0) {
      return NextResponse.json({ error: 'Tidak ada bank terdaftar di Moota' }, { status: 404 });
    }

    // Fetch internal bank accounts
    const { data: internalAccounts, error: dbError } = await db
      .from('bank_accounts')
      .select('id, account_no, name, balance, bank_name')
      .eq('is_active', true);

    if (dbError) throw dbError;
    if (!internalAccounts || internalAccounts.length === 0) {
      return NextResponse.json(
        { error: 'Tidak ada rekening bank di database. Tambahkan rekening di Settings → Rekening Bank.' },
        { status: 404 }
      );
    }

    // Filter Moota banks if specific bankId requested
    const banksToSync = targetBankId
      ? mootaBanks.filter(b => b.bank_id === targetBankId)
      : mootaBanks;

    const results: Array<{
      accountNo: string;
      mootaBalance: number;
      oldBalance: number;
      newBalance: number;
      matched: boolean;
      fromMutationFallback: boolean;
    }> = [];

    for (const mootaBank of banksToSync) {
      // --- Detailed logging: raw Moota bank data ---
      console.log(`[Moota Sync] Processing bank: account_number=${mootaBank.account_number}, bank_type=${mootaBank.bank_type}, balance="${mootaBank.balance}", bank_id=${mootaBank.bank_id}`);

      let mootaBalance = parseFloat(mootaBank.balance || '0');
      let fromMutationFallback = false;

      // --- Fix 1: Fallback to latest mutation balance when bank-level balance is 0 ---
      if (mootaBalance === 0 && mootaBank.bank_id) {
        console.log(`[Moota Sync] Bank-level balance is 0 for ${mootaBank.account_number}. Attempting mutation fallback...`);
        try {
          const mutations = await getMootaMutations(mootaBank.bank_id, { perPage: 1, page: 1 });
          if (mutations?.data?.length > 0) {
            const latestMutation = mutations.data[0];
            const mutationBalance = parseFloat(latestMutation.balance || '0');
            if (mutationBalance > 0) {
              mootaBalance = mutationBalance;
              fromMutationFallback = true;
              console.log(`[Moota Sync] ✅ Using fallback balance from latest mutation for ${mootaBank.account_number}: ${mootaBalance} (mutation date: ${latestMutation.date})`);
            } else {
              console.warn(`[Moota Sync] ⚠ Latest mutation balance is also 0 for ${mootaBank.account_number}`);
            }
          } else {
            console.warn(`[Moota Sync] ⚠ No mutations found for bank_id ${mootaBank.bank_id} (${mootaBank.account_number})`);
          }
        } catch (err) {
          console.warn(`[Moota Sync] ⚠ Could not fetch mutations for fallback balance (${mootaBank.account_number}):`, err);
        }
      }

      // --- Fix 3: More robust account number normalization ---
      // Strips spaces, dashes, dots, slashes, and parentheses that may appear in various bank formats
      const normalizeAccountNo = (no: string) =>
        (no || '').replace(/[\s\-\.\/\(\)]/g, '').replace(/^\+/, '');
      const normalizedAccountNo = normalizeAccountNo(mootaBank.account_number);

      // Find matching internal account (try exact and normalized match)
      const internalMatch = internalAccounts.find(ba => {
        const normalizedInternal = normalizeAccountNo(ba.account_no || '');
        return normalizedInternal === normalizedAccountNo || ba.account_no === mootaBank.account_number;
      });

      // --- Detailed logging: match result ---
      if (internalMatch) {
        console.log(`[Moota Sync] ✅ Matched: ${mootaBank.account_number} → internal account "${internalMatch.name}" (id: ${internalMatch.id})`);
      } else {
        console.log(`[Moota Sync] ❌ Unmatched: ${mootaBank.account_number} — no internal account found`);
      }

      const entry = {
        accountNo: mootaBank.account_number,
        mootaBalance,
        oldBalance: internalMatch ? Number(internalMatch.balance) : 0,
        newBalance: 0,
        matched: !!internalMatch,
        fromMutationFallback,
      };

      if (internalMatch) {
        // Update balance to match Moota's reported balance
        const { error: updateError } = await db
          .from('bank_accounts')
          .update({ balance: mootaBalance, updated_at: new Date().toISOString() })
          .eq('id', internalMatch.id);

        if (updateError) {
          console.error(`[Moota Sync] Failed to update ${mootaBank.account_number}:`, updateError);
          entry.newBalance = entry.oldBalance;
        } else {
          entry.newBalance = mootaBalance;
          // --- Detailed logging: final written balance ---
          console.log(`[Moota Sync] 💰 Balance written: ${mootaBank.account_number} → ${mootaBalance}${fromMutationFallback ? ' (from mutation fallback)' : ' (from Moota bank API)'} [was: ${entry.oldBalance}]`);
        }
      } else {
        entry.newBalance = 0;
      }

      results.push(entry);
    }

    const matched = results.filter(r => r.matched);
    const unmatched = results.filter(r => !r.matched);

    return NextResponse.json({
      success: true,
      synced: matched.length,
      unmatched: unmatched.length,
      results,
      message: `Saldo ${matched.length} rekening berhasil disinkronkan dari Moota.`,
      unmatchedMessage: unmatched.length > 0
        ? `${unmatched.length} rekening tidak cocok. Pastikan nomor rekening di Settings sama dengan Moota.`
        : undefined,
    });
  } catch (error) {
    console.error('[Moota Sync] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Gagal sinkronisasi saldo Moota' },
      { status: 500 }
    );
  }
}
