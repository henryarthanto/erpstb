// =====================================================================
// HEALTH CHECK ENDPOINT
// GET /api/health
//
// Returns system health report: database connectivity, memory, cache.
// MariaDB/Prisma mode — no Supabase or PgBouncer checks.
// =====================================================================

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/supabase';
import { verifyAuthToken } from '@/lib/token';
import { getCacheStatus } from '@/lib/redis-cache';

type CheckStatus = 'ok' | 'warning' | 'error';
type OverallStatus = 'healthy' | 'degraded' | 'unhealthy';

export async function GET(request: NextRequest) {
  const authUserId = verifyAuthToken(request.headers.get('authorization'));
  if (!authUserId) {
    return NextResponse.json({ status: 'ok' });
  }

  const timestamp = new Date().toISOString();
  const uptime = Math.floor(process.uptime());

  // Database check
  const dbStart = performance.now();
  let dbStatus: CheckStatus = 'ok';
  let dbLatency = 0;
  let dbError: string | undefined;
  try {
    await prisma.setting.findFirst({ select: { key: true }, take: 1 });
    dbLatency = Math.round(performance.now() - dbStart);
  } catch (err: any) {
    dbStatus = 'error';
    dbLatency = Math.round(performance.now() - dbStart);
    dbError = err?.message || 'Connection failed';
  }

  // Memory check
  const mem = process.memoryUsage();
  const totalMB = Math.round(mem.rss / 1024 / 1024);
  const heapUsedMB = Math.round(mem.heapUsed / 1024 / 1024);
  const heapTotalMB = Math.round(mem.heapTotal / 1024 / 1024);
  const memPercent = Math.round((mem.heapUsed / mem.heapTotal) * 100);

  // Cache status
  const cache = getCacheStatus();

  // Determine overall status
  let status: OverallStatus = 'healthy';
  if (dbStatus === 'error') status = 'unhealthy';
  else if (memPercent > 90) status = 'degraded';

  return NextResponse.json({
    status,
    mode: 'mariadb',
    timestamp,
    uptime,
    database: {
      status: dbStatus,
      latency_ms: dbLatency,
      error: dbError,
      url: process.env.DATABASE_URL?.replace(/:([^@]+)@/, ':****@') || 'not configured',
    },
    memory: {
      rss_mb: totalMB,
      heap_used_mb: heapUsedMB,
      heap_total_mb: heapTotalMB,
      heap_percent: memPercent,
    },
    cache,
  }, { status: status === 'unhealthy' ? 503 : 200 });
}
