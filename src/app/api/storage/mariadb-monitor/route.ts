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

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(' ');
}

async function getMariaDbStatus(): Promise<Record<string, string>> {
  const rows: any[] = await prisma.$queryRawUnsafe('SHOW GLOBAL STATUS');
  const map: Record<string, string> = {};
  for (const row of rows) {
    map[row.Variable_name] = row.Value;
  }
  return map;
}

async function getMariaDbVariables(): Promise<Record<string, string>> {
  const rows: any[] = await prisma.$queryRawUnsafe('SHOW GLOBAL VARIABLES');
  const map: Record<string, string> = {};
  for (const row of rows) {
    map[row.Variable_name] = row.Value;
  }
  return map;
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

    // ── 3. MariaDB version ─────────────────────────────────────────────
    let dbVersion: string | null = null;
    try {
      const versionRows: any[] = await prisma.$queryRawUnsafe('SELECT VERSION() as ver');
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
      engine: string;
    }> = [];

    try {
      const tableStatus: any[] = await prisma.$queryRawUnsafe(
        'SHOW TABLE STATUS FROM erp_db'
      );

      for (const row of tableStatus) {
        const dataLength = Number(row.Data_length) || 0;
        const indexLength = Number(row.Index_length) || 0;
        const rows = Number(row.Rows) || 0;
        const engine = row.Engine || 'InnoDB';
        const name = row.Name;

        totalDataBytes += dataLength;
        totalIndexBytes += indexLength;
        rowCounts[name] = rows;

        if (dataLength > 0 || indexLength > 0) {
          allTableData.push({ tableName: name, dataLength, indexLength, rowCount: rows, engine });
        }
      }
    } catch (err: any) {
      console.error('MariaDB monitor: SHOW TABLE STATUS failed:', err.message);
    }

    // ── 5. Top 15 tables by data size ──────────────────────────────────
    allTableData.sort((a, b) => b.dataLength - a.dataLength);
    const topTables = allTableData.slice(0, 15).map((t) => ({
      tableName: t.tableName,
      sizePretty: formatBytes(t.dataLength + t.indexLength),
      sizeBytes: t.dataLength + t.indexLength,
      dataSizePretty: formatBytes(t.dataLength),
      indexSizePretty: formatBytes(t.indexLength),
      rowCount: t.rowCount,
      engine: t.engine,
    }));

    // ── 6. MariaDB Global Status (realtime metrics) ────────────────────
    let status: Record<string, string> = {};
    let variables: Record<string, string> = {};
    try {
      [status, variables] = await Promise.all([
        getMariaDbStatus(),
        getMariaDbVariables(),
      ]);
    } catch (err: any) {
      console.error('MariaDB monitor: SHOW STATUS/VARIABLES failed:', err.message);
    }

    // Connection info
    const currentConnections = Number(status['Threads_connected']) || 0;
    const maxUsedConnections = Number(status['Max_used_connections']) || 0;
    const maxConnections = Number(variables['max_connections']) || 151;
    const connectionPercent = maxConnections > 0 ? Math.round((currentConnections / maxConnections) * 100) : 0;

    // Uptime
    const uptimeSeconds = Number(status['Uptime']) || 0;
    const uptimeFormatted = uptimeSeconds > 0 ? formatUptime(uptimeSeconds) : 'Unknown';

    // Query performance
    const questions = Number(status['Questions']) || 0;
    const queriesPerSec = uptimeSeconds > 0 ? parseFloat((questions / uptimeSeconds).toFixed(1)) : 0;
    const slowQueries = Number(status['Slow_queries']) || 0;
    const comSelect = Number(status['Com_select']) || 0;
    const comInsert = Number(status['Com_insert']) || 0;
    const comUpdate = Number(status['Com_update']) || 0;
    const comDelete = Number(status['Com_delete']) || 0;

    // InnoDB Buffer Pool
    const bufferPoolSize = Number(variables['innodb_buffer_pool_size']) || 0;
    const bufferPoolPagesTotal = Number(status['Innodb_buffer_pool_pages_total']) || 0;
    const bufferPoolPagesFree = Number(status['Innodb_buffer_pool_pages_free']) || 0;
    const bufferPoolPagesDirty = Number(status['Innodb_buffer_pool_pages_dirty']) || 0;
    const bufferPoolHitRate = bufferPoolPagesTotal > 0
      ? parseFloat((((bufferPoolPagesTotal - bufferPoolPagesFree) / bufferPoolPagesTotal) * 100).toFixed(1))
      : 0;
    const bufferPoolReads = Number(status['Innodb_buffer_pool_read_requests']) || 0;
    const bufferPoolDiskReads = Number(status['Innodb_buffer_pool_reads']) || 0;
    const bufferPoolRealHitRate = bufferPoolReads > 0
      ? parseFloat((((bufferPoolReads - bufferPoolDiskReads) / bufferPoolReads) * 100).toFixed(1))
      : 99.9;

    // Key Cache
    const keyCacheHitRate = (() => {
      const keyReads = Number(status['Key_reads']) || 0;
      const keyReadRequests = Number(status['Key_read_requests']) || 0;
      return keyReadRequests > 0 ? parseFloat(((1 - keyReads / keyReadRequests) * 100).toFixed(1)) : 99.9;
    })();

    // Table Cache
    const tableOpenCache = Number(variables['table_open_cache']) || 400;
    const openTables = Number(status['Open_tables']) || 0;
    const openedTables = Number(status['Opened_tables']) || 0;
    const tableCacheHitRate = openedTables > 0
      ? parseFloat(((openTables / (openTables + openedTables)) * 100).toFixed(1))
      : 99.9;

    // ── 7. Processlist ─────────────────────────────────────────────────
    let processlist: Array<{
      id: number;
      user: string;
      host: string;
      db: string | null;
      command: string;
      time: number;
      state: string | null;
      info: string | null;
    }> = [];

    try {
      const plRows: any[] = await prisma.$queryRawUnsafe('SHOW FULL PROCESSLIST');
      processlist = plRows.map((row) => ({
        id: Number(row.Id),
        user: row.User,
        host: row.Host,
        db: row.db,
        command: row.Command,
        time: Number(row.Time),
        state: row.State,
        info: row.Info,
      }));
    } catch (err: any) {
      console.error('MariaDB monitor: SHOW PROCESSLIST failed:', err.message);
    }

    // Active queries (running longer than 0s)
    const activeQueries = processlist.filter(p => p.command === 'Query' && p.time > 0);

    // ── 8. Disk usage (df -B1 /DATA) ───────────────────────────────────
    let diskUsage: {
      totalBytes: number;
      usedBytes: number;
      availableBytes: number;
      usedPercent: number;
      mountPoint: string;
    } | null = null;

    try {
      const dfOutput = execSync('df -B1 /DATA 2>/dev/null || df -B1 / 2>/dev/null', {
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
          tableName: 'erp_db',
          engine: 'MariaDB',
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
          host: '192.168.100.64',
          maxConnections,
        },

        // Connection Stats (realtime)
        connections: {
          current: currentConnections,
          maxUsed: maxUsedConnections,
          maxAllowed: maxConnections,
          percent: connectionPercent,
        },

        // Query Performance (realtime)
        queryPerformance: {
          questions,
          queriesPerSec,
          slowQueries,
          comSelect,
          comInsert,
          comUpdate,
          comDelete,
        },

        // Buffer Pool (realtime)
        bufferPool: {
          size: bufferPoolSize,
          sizePretty: formatBytes(bufferPoolSize),
          pagesTotal: bufferPoolPagesTotal,
          pagesFree: bufferPoolPagesFree,
          pagesDirty: bufferPoolPagesDirty,
          hitRate: bufferPoolHitRate,
          realHitRate: bufferPoolRealHitRate,
        },

        // Key Cache (realtime)
        keyCache: {
          hitRate: keyCacheHitRate,
        },

        // Table Cache (realtime)
        tableCache: {
          openTables,
          openedTables,
          openCacheLimit: tableOpenCache,
          hitRate: tableCacheHitRate,
        },

        // Processlist (realtime)
        processlist: {
          total: processlist.length,
          active: activeQueries.length,
          connections: processlist.filter(p => p.command === 'Sleep').length,
          activeQueries,
        },

        // Disk Usage
        diskUsage,

        // Latency
        latency: { dbLatencyMs },

        source: 'mariadb',
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error: any) {
    console.error('MariaDB monitor API error:', error.message);
    return NextResponse.json(
      { success: false, error: 'Gagal mengambil info MariaDB: ' + (error.message || 'Unknown error') },
      { status: 500 }
    );
  }
}
