// =====================================================================
// SETUP ENV — Auto-generate all env vars for Supabase/PostgreSQL mode
//
// GET  /api/setup-env  — Check current env config status (super_admin)
// POST /api/setup-env  — Generate complete .env content (super_admin)
//
// The POST endpoint reads existing config and derives all
// required database URLs for the Supabase/PostgreSQL setup.
// =====================================================================

import { NextRequest, NextResponse } from 'next/server';
import { verifyAndGetAuthUser } from '@/lib/token';
import { getCacheStatus } from '@/lib/redis-cache';

export async function POST(request: NextRequest) {
  try {
    const authResult = await verifyAndGetAuthUser(request.headers.get('authorization'), { role: true });
    if (!authResult || authResult.user.role !== 'super_admin') {
      return NextResponse.json({ error: 'Akses ditolak — hanya Super Admin' }, { status: 403 });
    }

    // Check that DATABASE_URL is configured
    const dbUrl = process.env.DATABASE_URL || '';
    const directUrl = process.env.DIRECT_URL || '';
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

    if (!dbUrl) {
      return NextResponse.json({
        error: 'DATABASE_URL tidak ditemukan. Set DATABASE_URL untuk koneksi Supabase/PostgreSQL.',
      }, { status: 400 });
    }

    // Build env content for Supabase/PostgreSQL mode
    const lines: string[] = [
      '# =====================================================================',
      '# Razkindo ERP — Auto-generated .env (Supabase/PostgreSQL Mode)',
      `# Generated: ${new Date().toISOString()}`,
      '# =====================================================================',
      '',
      '# ─── Database (Supabase/PostgreSQL) ─────────────────────────────────────',
      `DATABASE_URL="${dbUrl}"`,
      directUrl ? `DIRECT_URL="${directUrl}"` : '# DIRECT_URL="(optional, for migrations)"',
      '',
      '# ─── Supabase ───────────────────────────────────────────────────',
      supabaseUrl ? `NEXT_PUBLIC_SUPABASE_URL="${supabaseUrl}"` : '# NEXT_PUBLIC_SUPABASE_URL="(optional)"',
      anonKey ? `NEXT_PUBLIC_SUPABASE_ANON_KEY="${anonKey.substring(0, 8)}..."` : '# NEXT_PUBLIC_SUPABASE_ANON_KEY="(optional)"',
      serviceKey ? `SUPABASE_SERVICE_ROLE_KEY="${serviceKey.substring(0, 8)}..."` : '# SUPABASE_SERVICE_ROLE_KEY="(optional)"',
      '',
      '# ─── Authentication ────────────────────────────────────────────────',
    ];

    // Generate AUTH_SECRET if not set
    if (!process.env.AUTH_SECRET) {
      const crypto = await import('crypto');
      const secret = crypto.randomBytes(32).toString('hex');
      lines.push(`AUTH_SECRET="${secret}"`);
    } else {
      lines.push(`AUTH_SECRET="${process.env.AUTH_SECRET}"`);
    }

    lines.push('', '# ─── App Config ────────────────────────────────────────────');
    const isStb = process.env.STB_MODE === 'true' || process.env.STB_MODE === '1';
    lines.push(`STB_MODE=${isStb ? 'true' : 'false'}`);
    lines.push(`NODE_ENV=${process.env.NODE_ENV || 'production'}`);
    lines.push('', 'PORT=3000');

    if (process.env.MOOTA_PERSONAL_TOKEN) {
      lines.push('', '# ─── Moota API ─────────────────────────────────────────────');
      lines.push(`MOOTA_PERSONAL_TOKEN="${process.env.MOOTA_PERSONAL_TOKEN}"`);
    }

    if (process.env.REDIS_URL) {
      lines.push('', '# ─── Redis Cache ───────────────────────────────────────────');
      lines.push(`REDIS_URL="${process.env.REDIS_URL}"`);
    }

    return NextResponse.json({
      success: true,
      message: 'Env vars berhasil di-generate (Supabase/PostgreSQL mode)',
      mode: 'supabase',
      envContent: lines.join('\n'),
      whatToDo: [
        '1. Pastikan DATABASE_URL mengarah ke Supabase/PostgreSQL yang benar',
        '2. Simpan sebagai file .env di server/Docker container',
        '3. Restart aplikasi: docker restart erpstb',
        '4. Verifikasi: GET /api/setup-env → pastikan database.connected = true',
        '5. Cek kesehatan: GET /api/system/infrastructure → pastikan database status ok',
      ],
      expectedLatency: {
        cacheHit: '~5ms (in-memory)',
        dbQuery: '~20-80ms (Prisma/PostgreSQL direct)',
        realtimeSync: '~100ms (instant cache invalidation)',
      },
    });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Terjadi kesalahan' }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const authResult = await verifyAndGetAuthUser(request.headers.get('authorization'), { role: true });
    if (!authResult || authResult.user.role !== 'super_admin') {
      return NextResponse.json({ error: 'Akses ditolak' }, { status: 403 });
    }

    const cacheStatus = getCacheStatus();

    // Check database connectivity
    let dbConnected = false;
    let dbLatencyMs: number | null = null;
    try {
      const t0 = Date.now();
      const { prisma } = await import('@/lib/supabase');
      await prisma.$queryRaw`SELECT 1 as health_check`;
      dbConnected = true;
      dbLatencyMs = Date.now() - t0;
    } catch {
      dbConnected = false;
    }

    const vars: Record<string, { set: boolean; masked?: string }> = {};
    for (const key of [
      'DATABASE_URL', 'DIRECT_URL', 'AUTH_SECRET', 'STB_MODE', 'REDIS_URL',
      'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY',
    ]) {
      const val = process.env[key];
      const isSecret = key.includes('KEY') || key.includes('SECRET');
      const isDbUrl = key.includes('URL') || key.includes('DIRECT');
      vars[key] = {
        set: !!val && !val.startsWith('file:'),
        masked: val
          ? isSecret
            ? `${val.substring(0, 8)}...`
            : isDbUrl
              ? val.replace(/(\/\/[^:]+:)([^@]+)(@)/, '$1****$3')
              : val
          : undefined,
      };
    }

    // Recommendations
    const recs: string[] = [];
    if (!vars.DATABASE_URL.set) {
      recs.push('⚠️ DATABASE_URL belum di-set → Database TIDAK TERKONEKSI');
      recs.push('   Panggil POST /api/setup-env untuk generate .env lengkap');
    }
    if (vars.DATABASE_URL.set && !dbConnected) {
      recs.push('❌ DATABASE_URL set tapi GAGAL CONNECT → periksa URL dan kredensial database');
    }
    if (dbConnected) {
      recs.push(`✅ Database PostgreSQL TERKONEKSI — latensi ~${dbLatencyMs}ms`);
    }
    if (!vars.REDIS_URL.set) {
      recs.push('ℹ️ Redis tidak ada — menggunakan in-memory cache fallback');
    }

    return NextResponse.json({
      mode: 'supabase',
      database: { connected: dbConnected, latencyMs: dbLatencyMs },
      cache: cacheStatus,
      envVars: vars,
      recommendations: recs,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Terjadi kesalahan' }, { status: 500 });
  }
}
