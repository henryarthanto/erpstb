import { NextRequest, NextResponse } from 'next/server';
import { enforceSuperAdmin } from '@/lib/require-auth';
import { db } from '@/lib/supabase';

// =====================================================================
// MIGRATE CUSTOMER PWA - MariaDB mode
//
// In MariaDB/Prisma mode, all tables are managed by Prisma schema.
// This endpoint checks if PWA-related tables exist.
// =====================================================================

// GET /api/migrate-customer-pwa — Check if tables exist (super_admin only)
export async function GET(request: NextRequest) {
  try {
    const authResult = await enforceSuperAdmin(request);
    if (!authResult.success) return authResult.response;

    const checks = await Promise.all([
      db.from('cashback_config').select('id').limit(1),
      db.from('cashback_log').select('id').limit(1),
      db.from('cashback_withdrawal').select('id').limit(1),
      db.from('customer_prices').select('id').limit(1),
    ]);

    const tables = {
      cashback_config: !checks[0].error,
      cashback_log: !checks[1].error,
      cashback_withdrawal: !checks[2].error,
      customer_prices: !checks[3].error,
    };

    const allOk = Object.values(tables).every(Boolean);

    return NextResponse.json({
      ready: allOk,
      tables,
      message: allOk
        ? 'Semua tabel PWA sudah siap (MariaDB)'
        : 'Beberapa tabel belum dibuat. Jalankan: bun run db:push',
    });
  } catch (error: any) {
    return NextResponse.json({
      ready: false,
      error: error.message,
      message: 'Gagal mengecek status tabel',
    }, { status: 500 });
  }
}

// POST /api/migrate-customer-pwa — Schema managed by Prisma
export async function POST(request: NextRequest) {
  try {
    const authResult = await enforceSuperAdmin(request);
    if (!authResult.success) return authResult.response;

    return NextResponse.json({
      success: true,
      message: 'Migration not needed in MariaDB mode.',
      info: 'All tables are managed by Prisma schema. Run "bun run db:push" to sync.',
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: `Gagal: ${error.message}` },
      { status: 500 }
    );
  }
}
