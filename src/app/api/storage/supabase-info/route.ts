import { NextRequest, NextResponse } from 'next/server';
import { verifyAuthUser } from '@/lib/token';
import { prisma } from '@/lib/supabase';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export async function GET(request: NextRequest) {
  try {
    const authUserId = await verifyAuthUser(request.headers.get('authorization'));
    if (!authUserId) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    // ── Parse Supabase project info from env vars ─────────────────────────
    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const dbUrl = process.env.SUPABASE_DB_URL || process.env.DIRECT_URL || process.env.DATABASE_URL || '';
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

    let projectRef = '';
    let region = '';
    let awsEndpoint = '';
    let databaseHost = '';
    let dbPort = '5432';
    let dbName = 'postgres';

    // Parse project ref and region from SUPABASE_URL
    // e.g. https://[project-ref].supabase.co
    if (supabaseUrl) {
      try {
        const url = new URL(supabaseUrl);
        const parts = url.hostname.split('.');
        projectRef = parts[0] || '';
        // region might be in subdomain like xxx.region.supabase.co
        if (parts.length >= 3) {
          region = parts.slice(1, -1).join('.') || 'unknown';
        }
      } catch { /* keep defaults */ }
    }

    // Parse AWS endpoint from DATABASE_URL
    // e.g. postgresql://postgres.[project-ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres
    if (dbUrl) {
      try {
        const urlMatch = dbUrl.match(/@([^:]+):(\d+)\/(\w+)/);
        if (urlMatch) {
          databaseHost = urlMatch[1];
          dbPort = urlMatch[2];
          dbName = urlMatch[3];
          awsEndpoint = urlMatch[1];
        }

        // Extract region from host
        const regionMatch = dbUrl.match(/aws-0-([^.]+)\.pooler/);
        if (regionMatch) {
          region = regionMatch[1].replace(/-[a-z]$/, ''); // clean up pooler suffix
        }
      } catch { /* keep defaults */ }
    }

    // ── Storage buckets info ─────────────────────────────────────────────
    let buckets: Array<{
      id: string;
      name: string;
      public: boolean;
      createdAt: string | null;
      fileCount: number;
      totalSize: number;
      totalSizePretty: string;
    }> = [];

    try {
      const bucketRows: any[] = await prisma.$queryRawUnsafe(`
        SELECT
          b.id,
          b.name,
          b.public,
          b.created_at,
          b.updated_at,
          COALESCE((SELECT COUNT(*)::int FROM storage.objects o WHERE o.bucket_id = b.id), 0) AS file_count,
          COALESCE((SELECT SUM((o.metadata->>'size')::bigint) FROM storage.objects o WHERE o.bucket_id = b.id), 0) AS total_size
        FROM storage.buckets b
        ORDER BY b.name
      `);
      buckets = (bucketRows || []).map((row: any) => ({
        id: row.id,
        name: row.name,
        public: row.public || false,
        createdAt: row.created_at,
        fileCount: Number(row.file_count) || 0,
        totalSize: Number(row.total_size) || 0,
        totalSizePretty: formatBytes(Number(row.total_size) || 0),
      }));
    } catch (err: any) {
      console.error('[SupabaseInfo] Storage buckets query failed:', err.message);
    }

    // ── Total storage used ──────────────────────────────────────────────
    let totalStorageBytes = 0;
    try {
      const sizeRows: any[] = await prisma.$queryRawUnsafe(`
        SELECT COALESCE(SUM((metadata->>'size')::bigint), 0) AS total_size
        FROM storage.objects
      `);
      totalStorageBytes = Number(sizeRows[0]?.total_size) || 0;
    } catch {
      // storage.objects table might not exist
    }

    // ── Database version & uptime ────────────────────────────────────────
    let dbVersion = 'Unknown';
    let dbUptime = 'Unknown';
    try {
      const verRows: any[] = await prisma.$queryRawUnsafe('SELECT version() as ver');
      if (verRows.length > 0) {
        dbVersion = verRows[0].ver || 'Unknown';
      }
    } catch { /* ignore */ }

    try {
      const upRows: any[] = await prisma.$queryRawUnsafe(`
        SELECT extract(epoch FROM now() - pg_postmaster_start_time())::int AS uptime
      `);
      if (upRows.length > 0) {
        const seconds = Number(upRows[0].uptime) || 0;
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const parts: string[] = [];
        if (days > 0) parts.push(`${days}d`);
        if (hours > 0 || days > 0) parts.push(`${hours}h`);
        parts.push(`${minutes}m`);
        dbUptime = parts.join(' ');
      }
    } catch { /* ignore */ }

    return NextResponse.json({
      success: true,
      data: {
        project: {
          ref: projectRef,
          region,
          url: supabaseUrl,
        },
        aws: {
          endpoint: awsEndpoint,
          databaseHost,
          databasePort: dbPort,
          databaseName: dbName,
        },
        storage: {
          buckets,
          totalBytes: totalStorageBytes,
          totalPretty: formatBytes(totalStorageBytes),
        },
        database: {
          version: dbVersion,
          uptime: dbUptime,
        },
      },
    });
  } catch (error: any) {
    console.error('[SupabaseInfo] API error:', error.message);
    return NextResponse.json(
      { success: false, error: 'Gagal mengambil info Supabase: ' + (error.message || 'Unknown error') },
      { status: 500 }
    );
  }
}
