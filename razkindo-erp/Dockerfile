# ============================================
# Razkindo ERP - Production Dockerfile (STB)
# Supports: ARM64 (Raspberry Pi) + AMD64 (x86)
# ============================================

# --- Stage 1: Dependencies ---
FROM oven/bun:1-alpine AS deps
WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

# --- Stage 2: Build ---
FROM oven/bun:1-alpine AS builder
WORKDIR /app

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Generate Prisma client
RUN bunx prisma generate

# Build Next.js standalone
ENV STB_MODE=true
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

RUN bun run build

# --- Stage 3: Production ---
FROM oven/bun:1-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV STB_MODE=true
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000

# Create non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 appuser

# Copy standalone output
COPY --from=builder /app/.next/standalone ./

# Copy static assets (Next.js public + .next/static)
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Copy Caddyfile
COPY Caddyfile /etc/caddy/Caddyfile

# Create required directories
RUN mkdir -p /app/db && \
    mkdir -p /app/logs && \
    chown -R appuser:nodejs /app

USER appuser

EXPOSE 3000 81

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1

CMD ["bun", "server.js"]
