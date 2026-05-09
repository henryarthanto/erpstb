import { createServer } from "http";
import { Server } from "socket.io";
import mysql from "mysql2/promise";
import { readFileSync, readdirSync, existsSync } from "fs";
import { execSync } from "child_process";

// ─── Config ────────────────────────────────────────────────────────────────────

const PORT = 3004;
const POLL_INTERVAL_MS = 3000;

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "mysql://root:password@192.168.100.64:3306/erp_db";

// Parse mysql://user:pass@host:port/db from DATABASE_URL
function parseMysqlUrl(url: string) {
  // Handle URL-encoded passwords
  const cleaned = url.replace(/^mysql:\/\//, "");
  const atIndex = cleaned.lastIndexOf("@");
  const slashIndex = cleaned.indexOf("/", atIndex);
  const credentials = cleaned.substring(0, atIndex);
  const colonIndex = credentials.indexOf(":");
  const user = decodeURIComponent(credentials.substring(0, colonIndex));
  const password = decodeURIComponent(credentials.substring(colonIndex + 1));
  const hostPort = cleaned.substring(atIndex + 1, slashIndex);
  const database = cleaned.substring(slashIndex + 1).split("?")[0];
  const lastColon = hostPort.lastIndexOf(":");
  const host = hostPort.substring(0, lastColon);
  const port = parseInt(hostPort.substring(lastColon + 1), 10);
  return { user, password, host, port, database };
}

// ─── CPU Tracking State ───────────────────────────────────────────────────────

let prevCpuTicks: { idle: number; total: number } | null = null;

function parseProcStat() {
  const raw = readFileSync("/proc/stat", "utf-8").split("\n")[0];
  // cpu  user nice system idle iowait irq softirq steal guest guest_nice
  const parts = raw.split(/\s+/).slice(1).map(Number);
  const idle = parts[3] + (parts[4] || 0); // idle + iowait
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
  const usage = ((totalDiff - idleDiff) / totalDiff) * 100;
  return Math.round(usage * 100) / 100;
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
    memTotal,
    memFree,
    memAvailable,
    buffers,
    cached,
    swapTotal,
    swapFree,
    swapUsed: swapTotal - swapFree,
    memUsedPercent: Math.round(((memTotal - memAvailable) / memTotal) * 10000) / 100,
  };
}

// ─── Load Average ──────────────────────────────────────────────────────────────

interface LoadAvg {
  load1: number;
  load5: number;
  load15: number;
  running: number;
  total: number;
}

function getLoadAvg(): LoadAvg {
  const raw = readFileSync("/proc/loadavg", "utf-8").trim();
  const parts = raw.split(/\s+/);
  return {
    load1: parseFloat(parts[0]),
    load5: parseFloat(parts[1]),
    load15: parseFloat(parts[2]),
    running: parseInt(parts[3].split("/")[0], 10),
    total: parseInt(parts[3].split("/")[1], 10),
  };
}

// ─── Disk Usage ────────────────────────────────────────────────────────────────

interface DiskUsage {
  filesystem: string;
  size: number;
  used: number;
  available: number;
  usedPercent: number;
  mountPoint: string;
}

function getDiskUsage(): DiskUsage {
  const targets = ["/DATA", "/"];
  for (const target of targets) {
    try {
      const raw = execSync(`df -B1 ${target} 2>/dev/null`, {
        encoding: "utf-8",
      }).trim();
      const lines = raw.split("\n");
      if (lines.length >= 2) {
        const parts = lines[1].split(/\s+/);
        return {
          filesystem: parts[0],
          size: parseInt(parts[1], 10),
          used: parseInt(parts[2], 10),
          available: parseInt(parts[3], 10),
          usedPercent: parseFloat(parts[4]),
          mountPoint: parts[5],
        };
      }
    } catch {
      // continue to next target
    }
  }
  return {
    filesystem: "unknown",
    size: 0,
    used: 0,
    available: 0,
    usedPercent: 0,
    mountPoint: "/",
  };
}

// ─── CPU Temperature ──────────────────────────────────────────────────────────

function getCpuTemperature(): number | null {
  // Try thermal zones first
  try {
    const zones = readdirSync("/sys/class/thermal").filter((f) =>
      f.startsWith("thermal_zone")
    );
    for (const zone of zones) {
      const tempFile = `/sys/class/thermal/${zone}/temp`;
      if (existsSync(tempFile)) {
        const temp = parseInt(readFileSync(tempFile, "utf-8").trim(), 10);
        if (temp > 0) return temp / 1000;
      }
    }
  } catch {
    // ignore
  }
  // Try hwmon
  try {
    const hwmons = readdirSync("/sys/class/hwmon").filter((f) =>
      f.startsWith("hwmon")
    );
    for (const hw of hwmons) {
      const tempFile = `/sys/class/hwmon/${hw}/temp1_input`;
      if (existsSync(tempFile)) {
        const temp = parseInt(readFileSync(tempFile, "utf-8").trim(), 10);
        if (temp > 0) return temp / 1000;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

// ─── CPU Model ─────────────────────────────────────────────────────────────────

function getCpuModel(): string {
  try {
    const raw = readFileSync("/proc/cpuinfo", "utf-8");
    const match = raw.match(/model name\s*:\s*(.+)/);
    return match ? match[1].trim() : "Unknown";
  } catch {
    return "Unknown";
  }
}

// ─── Uptime ────────────────────────────────────────────────────────────────────

interface UptimeInfo {
  uptimeSeconds: number;
  formatted: string;
}

function getUptime(): UptimeInfo {
  const raw = readFileSync("/proc/uptime", "utf-8").trim();
  const seconds = parseFloat(raw.split(/\s+/)[0]);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const formatted = `${days}d ${hours}h ${minutes}m`;
  return { uptimeSeconds: seconds, formatted };
}

// ─── Collect All System Stats ─────────────────────────────────────────────────

interface SystemStats {
  cpu: {
    usagePercent: number;
    model: string;
    temperature: number | null;
  };
  memory: MemInfo;
  loadAvg: LoadAvg;
  disk: DiskUsage;
  uptime: UptimeInfo;
}

function collectSystemStats(): SystemStats {
  return {
    cpu: {
      usagePercent: getCpuUsage(),
      model: getCpuModel(),
      temperature: getCpuTemperature(),
    },
    memory: getMemInfo(),
    loadAvg: getLoadAvg(),
    disk: getDiskUsage(),
    uptime: getUptime(),
  };
}

// ─── MariaDB Stats ─────────────────────────────────────────────────────────────

interface MariaDbStats {
  connected: boolean;
  latencyMs: number | null;
  version: string | null;
  uptime: number | null;
  connections: {
    current: number | null;
    maxConnections: number | null;
    threadsRunning: number | null;
    threadsConnected: number | null;
    abortedConnects: number | null;
    maxUsedConnections: number | null;
  };
  queries: {
    queriesPerSecond: number | null;
    totalQuestions: number | null;
    slowQueries: number | null;
    comSelect: number | null;
    comInsert: number | null;
    comUpdate: number | null;
    comDelete: number | null;
  };
  bufferPool: {
    size: number | null;
    pagesTotal: number | null;
    pagesData: number | null;
    pagesDirty: number | null;
    pagesFree: number | null;
    hitRate: number | null;
  };
  innodb: {
    rowLockWaits: number | null;
    rowLockTimeAvg: number | null;
    deadlocks: number | null;
    dataReads: number | null;
    dataWrites: number | null;
  };
  cache: {
    keyCacheHitRate: number | null;
    tableOpenCacheHitRate: number | null;
    openTables: number | null;
    openTablesLimit: number | null;
  };
  processlist: Array<{
    id: number | null;
    user: string;
    host: string;
    db: string | null;
    command: string;
    time: number;
    state: string | null;
    info: string | null;
  }>;
  error: string | null;
}

let prevQuestions: number | null = null;
let pool: mysql.Pool | null = null;
let lastQueryTime: Date | null = null;
let lastQuestionsCount: number | null = null;

function createPool(): mysql.Pool {
  const cfg = parseMysqlUrl(DATABASE_URL);
  return mysql.createPool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    waitForConnections: true,
    connectionLimit: 3,
    enableKeepAlive: true,
  });
}

function statusRowToMap(rows: Array<Record<string, string>>) {
  const map: Record<string, string> = {};
  for (const row of rows) {
    const keys = Object.keys(row);
    if (keys.length >= 2) {
      map[row[keys[0]]] = row[keys[1]];
    }
  }
  return map;
}

async function collectMariaDbStats(): Promise<MariaDbStats> {
  const emptyStats: MariaDbStats = {
    connected: false,
    latencyMs: null,
    version: null,
    uptime: null,
    connections: {
      current: null,
      maxConnections: null,
      threadsRunning: null,
      threadsConnected: null,
      abortedConnects: null,
      maxUsedConnections: null,
    },
    queries: {
      queriesPerSecond: null,
      totalQuestions: null,
      slowQueries: null,
      comSelect: null,
      comInsert: null,
      comUpdate: null,
      comDelete: null,
    },
    bufferPool: {
      size: null,
      pagesTotal: null,
      pagesData: null,
      pagesDirty: null,
      pagesFree: null,
      hitRate: null,
    },
    innodb: {
      rowLockWaits: null,
      rowLockTimeAvg: null,
      deadlocks: null,
      dataReads: null,
      dataWrites: null,
    },
    cache: {
      keyCacheHitRate: null,
      tableOpenCacheHitRate: null,
      openTables: null,
      openTablesLimit: null,
    },
    processlist: [],
    error: null,
  };

  if (!pool) {
    try {
      pool = createPool();
    } catch (e) {
      return { ...emptyStats, error: (e as Error).message };
    }
  }

  try {
    // 1. Latency measurement via SELECT 1
    const latStart = Date.now();
    await pool.execute("SELECT 1");
    const latencyMs = Date.now() - latStart;

    // Run queries in parallel
    const [statusRows, varRows, processRows] = await Promise.all([
      pool.execute("SHOW GLOBAL STATUS") as Promise<[Array<Record<string, string>>]>,
      pool.execute("SHOW GLOBAL VARIABLES") as Promise<[Array<Record<string, string>>]>,
      pool.execute("SHOW FULL PROCESSLIST") as Promise<[Array<Record<string, unknown>>]>,
    ]);

    const status = statusRowToMap(statusRows[0]);
    const variables = statusRowToMap(varRows[0]);

    const n = (key: string) => {
      const v = status[key] ?? variables[key];
      return v !== undefined ? parseInt(v, 10) : null;
    };

    // Queries per second
    const now = new Date();
    const totalQuestions = n("Questions");
    let queriesPerSecond: number | null = null;
    if (totalQuestions !== null && lastQuestionsCount !== null && lastQueryTime) {
      const elapsed = (now.getTime() - lastQueryTime.getTime()) / 1000;
      if (elapsed > 0) {
        queriesPerSecond =
          Math.round(((totalQuestions - lastQuestionsCount) / elapsed) * 100) /
          100;
      }
    }
    lastQuestionsCount = totalQuestions;
    lastQueryTime = now;

    // Buffer pool hit rate
    const bpReads = n("Innodb_buffer_pool_reads");
    const bpReadRequests = n("Innodb_buffer_pool_read_requests");
    let bufferPoolHitRate: number | null = null;
    if (bpReadRequests !== null && bpReadRequests > 0 && bpReads !== null) {
      bufferPoolHitRate =
        Math.round(((1 - bpReads / bpReadRequests) * 100) * 100) / 100;
    }

    // Key cache hit rate
    const keyReads = n("Key_reads");
    const keyReadRequests = n("Key_read_requests");
    let keyCacheHitRate: number | null = null;
    if (keyReadRequests !== null && keyReadRequests > 0 && keyReads !== null) {
      keyCacheHitRate =
        Math.round(((1 - keyReads / keyReadRequests) * 100) * 100) / 100;
    }

    // Table open cache hit rate
    const tableOpens = n("Table_open_cache_hits");
    const tableOpenCacheOverflows = n("Table_open_cache_overflows");
    let tableOpenCacheHitRate: number | null = null;
    if (tableOpens !== null && tableOpenCacheOverflows !== null) {
      const total = tableOpens + tableOpenCacheOverflows;
      if (total > 0) {
        tableOpenCacheHitRate =
          Math.round((tableOpens / total) * 10000) / 100;
      }
    }

    // Version from VERSION or version comment
    const version = status["Server_version"] || variables["version"] || null;

    // Processlist parsing
    const processlist = (processRows[0] || []).map((row) => ({
      id: (row["Id"] as number) ?? null,
      user: String(row["User"] ?? ""),
      host: String(row["Host"] ?? ""),
      db: (row["db"] as string) ?? null,
      command: String(row["Command"] ?? ""),
      time: Number(row["Time"] ?? 0),
      state: (row["State"] as string) ?? null,
      info: (row["Info"] as string) ?? null,
    }));

    return {
      connected: true,
      latencyMs,
      version,
      uptime: n("Uptime"),
      connections: {
        current: n("Threads_connected"),
        maxConnections: n("max_connections"),
        threadsRunning: n("Threads_running"),
        threadsConnected: n("Threads_connected"),
        abortedConnects: n("Aborted_connects"),
        maxUsedConnections: n("Max_used_connections"),
      },
      queries: {
        queriesPerSecond,
        totalQuestions,
        slowQueries: n("Slow_queries"),
        comSelect: n("Com_select"),
        comInsert: n("Com_insert"),
        comUpdate: n("Com_update"),
        comDelete: n("Com_delete"),
      },
      bufferPool: {
        size: n("innodb_buffer_pool_size"),
        pagesTotal: n("Innodb_buffer_pool_pages_total"),
        pagesData: n("Innodb_buffer_pool_pages_data"),
        pagesDirty: n("Innodb_buffer_pool_pages_dirty"),
        pagesFree: n("Innodb_buffer_pool_pages_free"),
        hitRate: bufferPoolHitRate,
      },
      innodb: {
        rowLockWaits: n("Innodb_row_lock_waits"),
        rowLockTimeAvg:
          n("Innodb_row_lock_time") && n("Innodb_row_lock_waits")
            ? Math.round(
                n("Innodb_row_lock_time")! / n("Innodb_row_lock_waits")!
              )
            : null,
        deadlocks: n("Innodb_deadlocks"),
        dataReads: n("Innodb_data_reads"),
        dataWrites: n("Innodb_data_writes"),
      },
      cache: {
        keyCacheHitRate,
        tableOpenCacheHitRate,
        openTables: n("Open_tables"),
        openTablesLimit: n("table_open_cache"),
      },
      processlist,
      error: null,
    };
  } catch (e) {
    return { ...emptyStats, error: (e as Error).message };
  }
}

// ─── Socket.io Server ─────────────────────────────────────────────────────────

const httpServer = createServer();

const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  transports: ["websocket", "polling"],
});

let activeClients = new Set<string>();
let broadcasting = false;

// ─── Change Relay Stats ──────────────────────────────────────────────────────

let changeRelayCount = 0;
let lastChangeAt: Date | null = null;

io.on("connection", (socket) => {
  const clientId = socket.id;
  activeClients.add(clientId);
  console.log(`[MonitorWS] Client connected: ${clientId} (total: ${activeClients.size})`);

  // Start broadcasting if this is the first client
  if (!broadcasting && activeClients.size > 0) {
    startBroadcasting();
  }

  // ─── REALTIME SYNC: Relay db:change events from Next.js server ───
  // The Next.js instrumentation connects as a Socket.io client and
  // emits db:change events after database mutations. We relay these
  // to all browser clients so they can update their UI instantly.
  socket.on("db:change", (event: {
    table: string;
    action: string;
    recordId?: string;
    record?: Record<string, unknown>;
    unitId?: string;
    timestamp: string;
  }) => {
    changeRelayCount++;
    lastChangeAt = new Date();
    // Relay to ALL other connected clients (not back to the sender)
    socket.broadcast.emit("data:change", event);
    // Log occasionally (not every single change)
    if (changeRelayCount <= 10 || changeRelayCount % 50 === 0) {
      console.log(
        `[MonitorWS] Relayed change #${changeRelayCount}: ${event.action} on ${event.table}${event.recordId ? ` (${event.recordId})` : ''}`
      );
    }
  });

  socket.on("monitor:start", () => {
    console.log(`[MonitorWS] Client ${clientId} requested start`);
    // Already broadcasting, but ensure it's running
    if (!broadcasting) {
      startBroadcasting();
    }
  });

  socket.on("monitor:stop", () => {
    console.log(`[MonitorWS] Client ${clientId} requested stop`);
  });

  socket.on("disconnect", (reason) => {
    activeClients.delete(clientId);
    console.log(
      `[MonitorWS] Client disconnected: ${clientId} (reason: ${reason}, total: ${activeClients.size})`
    );
    // Stop broadcasting if no clients remain
    if (activeClients.size === 0 && broadcasting) {
      stopBroadcasting();
    }
  });
});

// ─── Broadcast Loop ────────────────────────────────────────────────────────────

let broadcastTimer: ReturnType<typeof setInterval> | null = null;

async function broadcastData() {
  if (activeClients.size === 0) return;

  try {
    const [systemStats, mariaDbStats] = await Promise.all([
      Promise.resolve(collectSystemStats()),
      collectMariaDbStats(),
    ]);

    const payload = {
      systemStats,
      mariaDbStats,
      timestamp: new Date().toISOString(),
    };

    io.emit("monitor:data", payload);
  } catch (err) {
    console.error("[MonitorWS] Error collecting data:", err);
  }
}

function startBroadcasting() {
  if (broadcasting) return;
  broadcasting = true;
  console.log("[MonitorWS] Starting data broadcast (interval: 3s)");
  // Broadcast immediately, then every 3s
  broadcastData();
  broadcastTimer = setInterval(broadcastData, POLL_INTERVAL_MS);
}

function stopBroadcasting() {
  if (broadcastTimer) {
    clearInterval(broadcastTimer);
    broadcastTimer = null;
  }
  broadcasting = false;
  console.log("[MonitorWS] Stopped data broadcast (no clients)");
}

// ─── Start Server ──────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`[MonitorWS] Socket.io monitor service running on port ${PORT}`);
  console.log(`[MonitorWS] Database: ${parseMysqlUrl(DATABASE_URL).host}:${parseMysqlUrl(DATABASE_URL).port}/${parseMysqlUrl(DATABASE_URL).database}`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("[MonitorWS] SIGTERM received, shutting down...");
  stopBroadcasting();
  if (pool) pool.end();
  io.close();
  httpServer.close();
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("[MonitorWS] SIGINT received, shutting down...");
  stopBroadcasting();
  if (pool) pool.end();
  io.close();
  httpServer.close();
  process.exit(0);
});
