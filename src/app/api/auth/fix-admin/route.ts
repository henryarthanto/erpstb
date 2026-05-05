import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/supabase';
import bcrypt from 'bcryptjs';

// ─────────────────────────────────────────────────────────────────────
// EMERGENCY ENDPOINT — Fix admin user in MariaDB directly via Prisma
//
// Bypasses the PostgREST wrapper entirely to diagnose and fix
// authentication issues after MariaDB migration.
//
// Usage: POST /api/auth/fix-admin
//   Body: { email: "admin@razkindo.com", password: "admin123" }
//
// Actions:
//   1. Lists ALL users in the database
//   2. If admin email not found → creates it (super_admin, approved)
//   3. If admin email found but wrong status → fixes it
//   4. If admin email found but wrong password → resets it
//
// ⚠️ SECURITY: This endpoint should be removed after initial setup!
// ─────────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { email, password } = body;

    if (!email || !password) {
      return NextResponse.json({ error: 'email dan password wajib diisi' }, { status: 400 });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // ─── 1. List all users (diagnostic) ──────────────────────────
    const allUsers = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        status: true,
        isActive: true,
        canLogin: true,
        createdAt: true,
      },
    });

    console.log('[fix-admin] All users in MariaDB:', allUsers.map(u => ({
      email: u.email,
      role: u.role,
      status: u.status,
      isActive: u.isActive,
      canLogin: u.canLogin,
    })));

    // ─── 2. Check if admin user exists ──────────────────────────
    const existingUser = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (!existingUser) {
      // ─── CREATE admin user ───────────────────────────────────
      const hashedPassword = await bcrypt.hash(password, 12);
      const newUser = await prisma.user.create({
        data: {
          email: normalizedEmail,
          password: hashedPassword,
          name: 'Super Admin',
          role: 'super_admin',
          status: 'approved',
          canLogin: true,
          isActive: true,
          nearCommission: 0,
          farCommission: 0,
        },
      });

      console.log('[fix-admin] Created new user:', {
        id: newUser.id,
        email: newUser.email,
        role: newUser.role,
        status: newUser.status,
      });

      return NextResponse.json({
        success: true,
        action: 'created',
        message: `User "${normalizedEmail}" berhasil dibuat sebagai super_admin`,
        user: {
          id: newUser.id,
          email: newUser.email,
          name: newUser.name,
          role: newUser.role,
          status: newUser.status,
          isActive: newUser.isActive,
          canLogin: newUser.canLogin,
        },
        allUsersCount: allUsers.length,
        previousUsers: allUsers.map(u => ({ email: u.email, role: u.role, status: u.status })),
      });
    }

    // ─── 3. User exists — check and fix fields ─────────────────
    const updates: Record<string, any> = {};
    const issues: string[] = [];

    if (existingUser.status !== 'approved') {
      updates.status = 'approved';
      issues.push(`status: ${existingUser.status} → approved`);
    }
    if (!existingUser.isActive) {
      updates.isActive = true;
      issues.push(`isActive: ${existingUser.isActive} → true`);
    }
    if (!existingUser.canLogin) {
      updates.canLogin = true;
      issues.push(`canLogin: ${existingUser.canLogin} → true`);
    }
    if (existingUser.role !== 'super_admin') {
      updates.role = 'super_admin';
      issues.push(`role: ${existingUser.role} → super_admin`);
    }

    // Verify password
    const passwordMatch = await bcrypt.compare(password, existingUser.password);
    if (!passwordMatch) {
      updates.password = await bcrypt.hash(password, 12);
      issues.push('password: direset (hash lama tidak cocok)');
    }

    if (Object.keys(updates).length > 0) {
      const updatedUser = await prisma.user.update({
        where: { id: existingUser.id },
        data: updates,
      });

      console.log('[fix-admin] Fixed user:', issues);

      return NextResponse.json({
        success: true,
        action: 'fixed',
        message: `User "${normalizedEmail}" diperbaiki: ${issues.join(', ')}`,
        fixes: issues,
        user: {
          id: updatedUser.id,
          email: updatedUser.email,
          name: updatedUser.name,
          role: updatedUser.role,
          status: updatedUser.status,
          isActive: updatedUser.isActive,
          canLogin: updatedUser.canLogin,
        },
        allUsersCount: allUsers.length,
      });
    }

    // ─── 4. Everything is correct — password test ──────────────
    return NextResponse.json({
      success: true,
      action: 'verified',
      message: `User "${normalizedEmail}" sudah benar. Login seharusnya berhasil.`,
      passwordMatch,
      user: {
        id: existingUser.id,
        email: existingUser.email,
        name: existingUser.name,
        role: existingUser.role,
        status: existingUser.status,
        isActive: existingUser.isActive,
        canLogin: existingUser.canLogin,
      },
      allUsersCount: allUsers.length,
      allUsers: allUsers.map(u => ({
        email: u.email,
        role: u.role,
        status: u.status,
        isActive: u.isActive,
        canLogin: u.canLogin,
      })),
    });
  } catch (error: any) {
    console.error('[fix-admin] Error:', error);
    return NextResponse.json(
      { error: error?.message || 'Terjadi kesalahan server', stack: error?.stack },
      { status: 500 }
    );
  }
}
