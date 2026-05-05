import { NextRequest, NextResponse } from 'next/server';
import { verifyAuthUser } from '@/lib/token';
import { prisma } from '@/lib/supabase';
import { execSync } from 'child_process';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export async function GET(request: NextRequest) {
  try {
    // ── 1. Auth check ──────────────────────────────────────────────────
    const authUserId = await verifyAuthUser(request.headers.get('authorization'));
    if (!authUserId) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    // ── 2. Measure database latency ─────────────────────────────────────
    let dbLatencyMs: number | null = null;
    try {
      const latencyStart = Date.now();
      await prisma.$queryRawUnsafe('SELECT 1');
      dbLatencyMs = Date.now() - latencyStart;
    } catch {
      dbLatencyMs = null;
    }

    // ── 3. PostgreSQL version ──────────────────────────────────────────
    let dbVersion: string | null = null;
    try {
      const versionRows: any[] = await prisma.$queryRawUnsafe('SELECT version() as ver');
      if (versionRows.length > 0) {
        dbVersion = versionRows[0].ver || null;
      }
    } catch {
      // ignore
    }

    // ── 4. Database & table sizes ──────────────────────────────────────
    let totalDataBytes = 0;
    let totalIndexBytes = 0;
    const rowCounts: Record<string, number> = {};
    const allTableData: Array<{
      tableName: string;
      dataLength: number;
      indexLength: number;
      rowCount: number;
    }> = [];

    try {
      const tableStats: any[] = await prisma.$queryRawUnsafe(`
        SELECT
          c.relname AS table_name,
          pg_total_relation_size(c.oid) AS total_size,
          pg_relation_size(c.oid) AS data_size,
          pg_indexes_size(c.oid) AS index_size,
          c.reltuples::bigint AS row_count
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
        ORDER BY pg_total_relation_size(c.oid) DESC
      `);

      for (const row of tableStats) {
        const dataLength = Number(row.data_size) || 0;
        const indexLength = Number(row.index_size) || 0;
        const rows = Number(row.row_count) || 0;
        const name = row.table_name;

        totalDataBytes += dataLength;
        totalIndexBytes += indexLength;
        rowCounts[name] = rows;

        if (dataLength > 0 || indexLength > 0) {
          allTableData.push({ tableName: name, dataLength, indexLength, rowCount: rows });
        }
      }
    } catch (err: any) {
      console.error('PostgreSQL monitor: table size query failed:', err.message);
    }

    // ── 5. Top 15 tables by data size ──────────────────────────────────
    allTableData.sort((a, b) => (b.dataLength + b.indexLength) - (a.dataLength + a.indexLength));
    const topTables = allTableData.slice(0, 15).map((t) => ({
      tableName: t.tableName,
      sizePretty: formatBytes(t.dataLength + t.indexLength),
      sizeBytes: t.dataLength + t.indexLength,
      dataSizePretty: formatBytes(t.dataLength),
      indexSizePretty: formatBytes(t.indexLength),
      rowCount: t.rowCount,
    }));

    // ── 6. PostgreSQL pg_stat_database metrics ──────────────────────────
    let dbStats: Record<string, any> = {};
    try {
      const statsRows: any[] = await prisma.$queryRawUnsafe(`
        SELECT * FROM pg_stat_database WHERE datname = current_database()
      `);
      if (statsRows.length > 0) dbStats = statsRows[0];
    } catch (err: any) {
      console.error('PostgreSQL monitor: pg_stat_database failed:', err.message);
    }

    // ── 7. Active connections from pg_stat_activity ─────────────────────
    let activeQueries: Array<{
      pid: number;
      user: string;
      application: string | null;
      clientAddr: string | null;
      state: string;
      query: string;
      durationSec: number;
    }> = [];

    try {
      const actRows: any[] = await prisma.$queryRawUnsafe(`
        SELECT
          pid, usename, application_name, client_addr, state, query,
          extract(epoch FROM now() - query_start)::int AS duration_seconds
        FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid() AND state != 'idle'
        ORDER BY query_start
      `);
      activeQueries = actRows.map((row) => ({
        pid: Number(row.pid),
        user: row.usename,
        application: row.application_name,
        clientAddr: row.client_addr?.toString() || null,
        state: row.state,
        query: row.query,
        durationSec: Number(row.duration_seconds) || 0,
      }));
    } catch (err: any) {
      console.error('PostgreSQL monitor: pg_stat_activity failed:', err.message);
    }

    // Connection summary
    let totalConnections = 0;
    let idleConnections = 0;
    try {
      const connRows: any[] = await prisma.$queryRawUnsafe(`
        SELECT state, count(*)::int FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
        GROUP BY state
      `);
      for (const row of connRows) {
        totalConnections += Number(row.count) || 0;
        if (row.state === 'idle') idleConnections = Number(row.count) || 0;
      }
    } catch { /* ignore */ }

    // Uptime (from pg_postmaster_start_time)
    let uptimeSeconds = 0;
    let uptimeFormatted = 'Unknown';
    try {
      const uptimeRows: any[] = await prisma.$queryRawUnsafe(`
        SELECT extract(epoch FROM now() - pg_postmaster_start_time())::int AS uptime
      `);
      if (uptimeRows.length > 0) {
        uptimeSeconds = Number(uptimeRows[0].uptime) || 0;
        const days = Math.floor(uptimeSeconds / 86400);
        const hours = Math.floor((uptimeSeconds % 86400) / 3600);
        const minutes = Math.floor((uptimeSeconds % 3600) / 60);
        const parts: string[] = [];
        if (days > 0) parts.push(`${days}d`);
        if (hours > 0 || days > 0) parts.push(`${hours}h`);
        parts.push(`${minutes}m`);
        uptimeFormatted = parts.join(' ');
      }
    } catch { /* ignore */ }

    // ── 8. Disk usage ──────────────────────────────────────────────────
    let diskUsage: {
      totalBytes: number;
      usedBytes: number;
      availableBytes: number;
      usedPercent: number;
      mountPoint: string;
    } | null = null;

    try {
      const dfOutput = execSync('df -B1 / 2>/dev/null', {
        encoding: 'utf-8',
        timeout: 5000,
      });
      const lines = dfOutput.trim().split('\n');
      if (lines.length >= 2) {
        const parts = lines[1].trim().split(/\s+/);
        if (parts.length >= 6) {
          diskUsage = {
            totalBytes: parseInt(parts[1], 10) || 0,
            usedBytes: parseInt(parts[2], 10) || 0,
            availableBytes: parseInt(parts[3], 10) || 0,
            usedPercent: parseInt(parts[4], 10) || 0,
            mountPoint: parts[5] || '/',
          };
        }
      }
    } catch {
      // ignore
    }

    // ── Build response ──────────────────────────────────────────────────
    return NextResponse.json({
      success: true,
      data: {
        // Database Info
        database: {
          sizeBytes: totalDataBytes,
          sizePretty: formatBytes(totalDataBytes),
          engine: 'PostgreSQL',
        },
        indexes: {
          sizeBytes: totalIndexBytes,
          sizePretty: formatBytes(totalIndexBytes),
        },
        topTables,
        rowCounts,

        // Server Info
        serverInfo: {
          dbVersion: dbVersion || 'Unknown',
          uptime: uptimeFormatted,
          uptimeSeconds,
        },

        // Connection Stats
        connections: {
          current: totalConnections,
          active: activeQueries.length,
          idle: idleConnections,
        },

        // Query Stats (from pg_stat_database)
        queryPerformance: {
          totalTransactions: Number(dbStats.xact_commit) || 0,
          totalRollbacks: Number(dbStats.xact_rollback) || 0,
          deadlocks: Number(dbStats.deadlocks) || 0,
          tempBytes: Number(dbStats.temp_bytes) || 0,
          tempFiles: Number(dbStats.temp_files) || 0,
        },

        // Active Queries
        activeQueries,

        // Disk Usage
        diskUsage,

        // Latency
        latency: { dbLatencyMs },

        source: 'postgresql',
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error: any) {
    console.error('PostgreSQL monitor API error:', error.message);
    return NextResponse.json(
      { success: false, error: 'Gagal mengambil info database: ' + (error.message || 'Unknown error') },
      { status: 500 }
    );
  }
}
