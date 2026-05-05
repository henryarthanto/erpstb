import { createServer } from "http";
import { Server } from "socket.io";
import { Client } from "pg";
import { readFileSync, readdirSync, existsSync } from "fs";
import { execSync } from "child_process";

// ─── Config ────────────────────────────────────────────────────────────────────

const PORT = 3004;
const POLL_INTERVAL_MS = 3000;

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://localhost:5432/erp_db";

// ─── CPU Tracking State ───────────────────────────────────────────────────────

let prevCpuTicks: { idle: number; total: number } | null = null;

function parseProcStat() {
  const raw = readFileSync("/proc/stat", "utf-8").split("\n")[0];
  const parts = raw.split(/\s+/).slice(1).map(Number);
  const idle = parts[3] + (parts[4] || 0);
  const total = parts.reduce((a, b) => a + b, 0);
  return { idle, total };
}

function getCpuUsage(): number {
  const current = parseProcStat();
  if (!prevCpuTicks) {
    prevCpuTicks = current;
    return 0;
  }
  const idleDiff = current.idle - prevCpuTicks.idle;
  const totalDiff = current.total - prevCpuTicks.total;
  prevCpuTicks = current;
  if (totalDiff === 0) return 0;
  return Math.round(((totalDiff - idleDiff) / totalDiff) * 10000) / 100;
}

// ─── Memory ────────────────────────────────────────────────────────────────────

interface MemInfo {
  memTotal: number;
  memFree: number;
  memAvailable: number;
  buffers: number;
  cached: number;
  swapTotal: number;
  swapFree: number;
  swapUsed: number;
  memUsedPercent: number;
}

function getMemInfo(): MemInfo {
  const raw = readFileSync("/proc/meminfo", "utf-8");
  const get = (key: string) => {
    const match = raw.match(new RegExp(`${key}:\\s+(\\d+)`));
    return match ? parseInt(match[1], 10) : 0;
  };
  const memTotal = get("MemTotal");
  const memFree = get("MemFree");
  const memAvailable = get("MemAvailable");
  const buffers = get("Buffers");
  const cached = get("Cached");
  const swapTotal = get("SwapTotal");
  const swapFree = get("SwapFree");
  return {
    memTotal, memFree, memAvailable, buffers, cached,
    swapTotal, swapFree,
    swapUsed: swapTotal - swapFree,
    memUsedPercent: Math.round(((memTotal - memAvailable) / memTotal) * 10000) / 100,
  };
}

// ─── Load Average ──────────────────────────────────────────────────────────────

interface LoadAvg { load1: number; load5: number; load15: number; running: number; total: number; }

function getLoadAvg(): LoadAvg {
  const raw = readFileSync("/proc/loadavg", "utf-8").trim();
  const parts = raw.split(/\s+/);
  return {
    load1: parseFloat(parts[0]), load5: parseFloat(parts[1]), load15: parseFloat(parts[2]),
    running: parseInt(parts[3].split("/")[0], 10), total: parseInt(parts[3].split("/")[1], 10),
  };
}

// ─── Disk Usage ────────────────────────────────────────────────────────────────

interface DiskUsage { filesystem: string; size: number; used: number; available: number; usedPercent: number; mountPoint: string; }

function getDiskUsage(): DiskUsage {
  const targets = ["/DATA", "/"];
  for (const target of targets) {
    try {
      const raw = execSync(`df -B1 ${target} 2>/dev/null`, { encoding: "utf-8" }).trim();
      const lines = raw.split("\n");
      if (lines.length >= 2) {
        const parts = lines[1].split(/\s+/);
        return { filesystem: parts[0], size: parseInt(parts[1], 10), used: parseInt(parts[2], 10), available: parseInt(parts[3], 10), usedPercent: parseFloat(parts[4]), mountPoint: parts[5] };
      }
    } catch { /* continue */ }
  }
  return { filesystem: "unknown", size: 0, used: 0, available: 0, usedPercent: 0, mountPoint: "/" };
}

// ─── CPU Temperature ──────────────────────────────────────────────────────────

function getCpuTemperature(): number | null {
  try {
    const zones = readdirSync("/sys/class/thermal").filter((f) => f.startsWith("thermal_zone"));
    for (const zone of zones) {
      const tempFile = `/sys/class/thermal/${zone}/temp`;
      if (existsSync(tempFile)) {
        const temp = parseInt(readFileSync(tempFile, "utf-8").trim(), 10);
        if (temp > 0) return temp / 1000;
      }
    }
  } catch { /* ignore */ }
  return null;
}

// ─── CPU Model ─────────────────────────────────────────────────────────────────

function getCpuModel(): string {
  try {
    const raw = readFileSync("/proc/cpuinfo", "utf-8");
    const match = raw.match(/model name\s*:\s*(.+)/);
    return match ? match[1].trim() : "Unknown";
  } catch { return "Unknown"; }
}

// ─── Uptime ────────────────────────────────────────────────────────────────────

interface UptimeInfo { uptimeSeconds: number; formatted: string; }

function getUptime(): UptimeInfo {
  const raw = readFileSync("/proc/uptime", "utf-8").trim();
  const seconds = parseFloat(raw.split(/\s+/)[0]);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return { uptimeSeconds: seconds, formatted: `${days}d ${hours}h ${minutes}m` };
}

// ─── Collect All System Stats ─────────────────────────────────────────────────

interface SystemStats {
  cpu: { usagePercent: number; model: string; temperature: number | null; };
  memory: MemInfo;
  loadAvg: LoadAvg;
  disk: DiskUsage;
  uptime: UptimeInfo;
}

function collectSystemStats(): SystemStats {
  return {
    cpu: { usagePercent: getCpuUsage(), model: getCpuModel(), temperature: getCpuTemperature() },
    memory: getMemInfo(), loadAvg: getLoadAvg(), disk: getDiskUsage(), uptime: getUptime(),
  };
}

// ─── PostgreSQL Stats ─────────────────────────────────────────────────────────

interface PgStats {
  connected: boolean;
  latencyMs: number | null;
  version: string | null;
  uptime: number | null;
  connections: {
    current: number | null;
    active: number | null;
    idle: number | null;
    maxConnections: number | null;
  };
  queries: {
    totalTransactions: number | null;
    totalRollbacks: number | null;
    deadlocks: number | null;
    tempBytes: number | null;
    tempFiles: number | null;
  };
  processlist: Array<{
    pid: number;
    user: string;
    application: string | null;
    state: string;
    query: string;
    durationSec: number;
  }>;
  error: string | null;
}

let pgClient: Client | null = null;

async function getPgClient(): Promise<Client> {
  if (!pgClient) {
    pgClient = new Client({ connectionString: DATABASE_URL });
    await pgClient.connect();
  }
  return pgClient;
}

async function collectPgStats(): Promise<PgStats> {
  const empty: PgStats = {
    connected: false, latencyMs: null, version: null, uptime: null,
    connections: { current: null, active: null, idle: null, maxConnections: null },
    queries: { totalTransactions: null, totalRollbacks: null, deadlocks: null, tempBytes: null, tempFiles: null },
    processlist: [], error: null,
  };

  try {
    const client = await getPgClient();

    // 1. Latency
    const latStart = Date.now();
    await client.query("SELECT 1");
    const latencyMs = Date.now() - latStart;

    // 2. Parallel queries
    const [verRes, dbRes, actRes, settingsRes] = await Promise.all([
      client.query("SELECT version() as ver"),
      client.query("SELECT * FROM pg_stat_database WHERE datname = current_database()"),
      client.query(`
        SELECT pid, usename, application_name, state, query,
          extract(epoch FROM now() - query_start)::int AS duration_seconds
        FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()
        ORDER BY query_start LIMIT 50
      `),
      client.query("SELECT name, setting FROM pg_settings WHERE name = 'max_connections'"),
    ]);

    const version = verRes.rows[0]?.ver || null;
    const db = dbRes.rows[0] || {};
    const maxConn = parseInt(settingsRes.rows.find((r: any) => r.name === 'max_connections')?.setting || '100', 10);

    // Uptime from pg_postmaster_start_time
    let uptime: number | null = null;
    try {
      const upRes = await client.query("SELECT extract(epoch FROM now() - pg_postmaster_start_time())::int AS uptime");
      uptime = upRes.rows[0]?.uptime || null;
    } catch { /* ignore */ }

    // Connection counts
    const active = actRes.rows.filter((r: any) => r.state === 'active').length;
    const idle = actRes.rows.filter((r: any) => r.state === 'idle').length;

    return {
      connected: true, latencyMs, version, uptime,
      connections: { current: actRes.rows.length || null, active, idle, maxConnections: maxConn },
      queries: {
        totalTransactions: parseInt(db.xact_commit) || 0,
        totalRollbacks: parseInt(db.xact_rollback) || 0,
        deadlocks: parseInt(db.deadlocks) || 0,
        tempBytes: parseInt(db.temp_bytes) || 0,
        tempFiles: parseInt(db.temp_files) || 0,
      },
      processlist: actRes.rows.map((row: any) => ({
        pid: Number(row.pid), user: row.usename, application: row.application_name,
        state: row.state, query: row.query, durationSec: Number(row.duration_seconds) || 0,
      })),
      error: null,
    };
  } catch (e) {
    // Reset client on error so it reconnects next time
    if (pgClient) { try { await pgClient.end(); } catch { /* */ } pgClient = null; }
    return { ...empty, error: (e as Error).message };
  }
}

// ─── Socket.io Server ─────────────────────────────────────────────────────────

const httpServer = createServer();
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ["websocket", "polling"],
});

let activeClients = new Set<string>();
let broadcasting = false;
let changeRelayCount = 0;

io.on("connection", (socket) => {
  const clientId = socket.id;
  activeClients.add(clientId);
  console.log(`[MonitorWS] Client connected: ${clientId} (total: ${activeClients.size})`);

  if (!broadcasting) startBroadcasting();

  // REALTIME SYNC: Relay db:change events from Next.js server
  socket.on("db:change", (event: {
    table: string; action: string; recordId?: string;
    record?: Record<string, unknown>; unitId?: string; timestamp: string;
  }) => {
    changeRelayCount++;
    socket.broadcast.emit("data:change", event);
    if (changeRelayCount <= 10 || changeRelayCount % 50 === 0) {
      console.log(`[MonitorWS] Relayed change #${changeRelayCount}: ${event.action} on ${event.table}`);
    }
  });

  socket.on("monitor:start", () => { if (!broadcasting) startBroadcasting(); });
  socket.on("monitor:stop", () => {});
  socket.on("disconnect", (reason) => {
    activeClients.delete(clientId);
    console.log(`[MonitorWS] Client disconnected: ${clientId} (total: ${activeClients.size})`);
    if (activeClients.size === 0) stopBroadcasting();
  });
});

// ─── Broadcast Loop ────────────────────────────────────────────────────────────

let broadcastTimer: ReturnType<typeof setInterval> | null = null;

async function broadcastData() {
  if (activeClients.size === 0) return;
  try {
    const [systemStats, pgStats] = await Promise.all([
      Promise.resolve(collectSystemStats()),
      collectPgStats(),
    ]);
    io.emit("monitor:data", { systemStats, pgStats, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error("[MonitorWS] Error collecting data:", err);
  }
}

function startBroadcasting() {
  if (broadcasting) return;
  broadcasting = true;
  console.log("[MonitorWS] Starting data broadcast (interval: 3s)");
  broadcastData();
  broadcastTimer = setInterval(broadcastData, POLL_INTERVAL_MS);
}

function stopBroadcasting() {
  if (broadcastTimer) { clearInterval(broadcastTimer); broadcastTimer = null; }
  broadcasting = false;
  console.log("[MonitorWS] Stopped data broadcast (no clients)");
}

// ─── Start Server ──────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`[MonitorWS] Socket.io monitor service running on port ${PORT}`);
  console.log(`[MonitorWS] Database: PostgreSQL (${DATABASE_URL.replace(/:[^:@]+@/, ':****@')})`);
});

process.on("SIGTERM", async () => {
  console.log("[MonitorWS] SIGTERM, shutting down...");
  stopBroadcasting();
  if (pgClient) await pgClient.end();
  io.close();
  httpServer.close();
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("[MonitorWS] SIGINT, shutting down...");
  stopBroadcasting();
  if (pgClient) await pgClient.end();
  io.close();
  httpServer.close();
  process.exit(0);
});
