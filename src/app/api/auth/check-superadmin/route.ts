import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';

// GET /api/auth/check-superadmin
// Returns whether a super_admin account already exists (used to hide role in registration)
// PUBLIC endpoint — needed on the login/register page where user has no token.
// The register route has its own server-side check to prevent duplicate super_admin.
export async function GET(request: NextRequest) {
  try {
    const { count } = await db
      .from('users')
      .select('*', { count: 'exact', head: true })
      .eq('role', 'super_admin')
      .eq('is_active', true);
    return NextResponse.json({ exists: (count || 0) > 0 });
  } catch (error) {
    console.error('Check super admin error:', error);
    return NextResponse.json({ error: 'Terjadi kesalahan server' }, { status: 500 });
  }
}
