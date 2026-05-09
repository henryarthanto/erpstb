import { NextRequest, NextResponse } from 'next/server';
import { enforceSuperAdmin } from '@/lib/require-auth';
import { prisma } from '@/lib/supabase';

// =====================================================================
// SETUP SCHEMA - Check if MariaDB tables exist (requires auth)
//
// In MariaDB/Prisma mode, schema is managed via Prisma migrations.
// This endpoint checks if core tables exist by querying the database.
// =====================================================================

export async function GET(request: NextRequest) {
  try {
    const authResult = await enforceSuperAdmin(request);
    if (!authResult.success) return authResult.response;

    // Try a simple query to verify database is reachable and tables exist
    try {
      await prisma.setting.findFirst({ select: { key: true }, take: 1 });
      return NextResponse.json({
        success: true,
        message: 'Database schema already exists (MariaDB/Prisma)',
        tablesExist: true,
        mode: 'mariadb',
      });
    } catch {
      return NextResponse.json({
        success: false,
        message: 'Database tables not found.',
        tablesExist: false,
        mode: 'mariadb',
        instructions: [
          '1. Run: bun run db:push',
          '2. This will create all tables from Prisma schema',
          '3. Refresh the ERP page',
        ],
      });
    }
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const authResult = await enforceSuperAdmin(request);
    if (!authResult.success) return authResult.response;

    return NextResponse.json({
      success: false,
      error: 'Schema management via this endpoint is not available in MariaDB mode.',
      instructions: [
        '1. Run: bun run db:push — pushes Prisma schema to MariaDB',
        '2. Run: bun run db:generate — regenerates Prisma client',
        '3. Restart the server',
      ],
    }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
