import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/supabase';
import { toCamelCase } from '@/lib/supabase-helpers';
import { enforceSuperAdmin } from '@/lib/require-auth';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ key: string }> }
) {
  let settingKey = '';
  try {
    const authResult = await enforceSuperAdmin(request);
    if (!authResult.success) return authResult.response;

    const { key } = await params;
    settingKey = key;
    const { value } = await request.json();
    const jsonValue = JSON.stringify(value);

    // Use Prisma directly for reliability — bypass custom query builder
    let setting;
    const existing = await prisma.setting.findUnique({ where: { key } });

    if (existing) {
      // Update existing row
      setting = await prisma.setting.update({
        where: { key },
        data: { value: jsonValue },
      });
    } else {
      // Insert new row — Prisma auto-generates id, createdAt, updatedAt
      setting = await prisma.setting.create({
        data: { key, value: jsonValue },
      });
    }

    console.log(`[Settings] Saved "${key}" (${jsonValue.length} bytes)`);

    // Invalidate related caches for public-facing settings
    if (['company_logo', 'company_name', 'login_warning'].includes(key)) {
      try {
        const { cacheInvalidatePrefix } = await import('@/lib/redis-cache');
        await cacheInvalidatePrefix('settings');
      } catch { /* cache optional */ }
    }

    return NextResponse.json({ setting: toCamelCase(setting) });
  } catch (error: any) {
    console.error('[Settings] Update error for key:', settingKey, error?.message || error);
    return NextResponse.json(
      { error: 'Terjadi kesalahan server' },
      { status: 500 }
    );
  }
}
