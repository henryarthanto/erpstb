import type { NextConfig } from "next";
import { readFileSync } from "fs";
import { resolve } from "path";

// ─────────────────────────────────────────────────────────────────────
// FORCE LOAD .env OVERRIDES
// Shell environment may have stale DATABASE_URL (e.g. SQLite path).
// We read .env file and override any PostgreSQL-related vars so
// Prisma always connects to Supabase, not local SQLite.
// ─────────────────────────────────────────────────────────────────────
try {
  const envPath = resolve(process.cwd(), '.env');
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const eqIdx = trimmed.indexOf('=');
      const key = trimmed.substring(0, eqIdx).trim();
      const value = trimmed.substring(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      // Only override database-related env vars, not all of them
      if (key === 'DATABASE_URL' || key === 'DIRECT_URL') {
        process.env[key] = value;
      }
    }
  }
  console.log(`[next.config] DATABASE_URL overridden from .env ✓`);
} catch {
  // .env not found — use defaults
}

const nextConfig: NextConfig = {
  output: 'standalone',
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  serverExternalPackages: ['@prisma/client', 'pg-native'],
  // allowedDevOrigins hanya untuk development
  ...(process.env.NODE_ENV !== 'production' && {
    allowedDevOrigins: [
      'https://*.space-z.ai',
    ],
  }),
};

export default nextConfig;
