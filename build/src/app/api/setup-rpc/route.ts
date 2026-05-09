import { NextRequest, NextResponse } from 'next/server';
import { enforceSuperAdmin } from '@/lib/require-auth';
import { RPC_DEFINITIONS } from '@/lib/ensure-rpc';

// =====================================================================
// SETUP RPC - Disabled in PostgreSQL mode
//
// PostgreSQL RPC functions (stored procedures) have been replaced by
// Prisma transactions. This endpoint returns an informational message.
// =====================================================================

export async function POST(request: NextRequest) {
  try {
    const authResult = await enforceSuperAdmin(request);
    if (!authResult.success) return authResult.response;

    return NextResponse.json({
      success: true,
      message: 'RPC functions are not needed in PostgreSQL mode.',
      info: 'All atomic operations now use Prisma $transaction instead of PostgreSQL stored procedures.',
      migratedFunctions: [
        'atomic_update_balance → atomic-ops.ts (Prisma $transaction)',
        'atomic_update_setting_balance → atomic-ops.ts (Prisma $transaction)',
        'atomic_decrement_stock → atomic-ops.ts (Prisma $transaction)',
        'atomic_add_cashback → atomic-cashback.ts (Prisma $transaction)',
      ],
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
