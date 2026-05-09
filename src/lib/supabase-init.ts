// =====================================================================
// SUPABASE INIT — Node.js only entry point for instrumentation.ts
//
// This file re-exports the Prisma singleton from supabase.ts.
// It exists solely to avoid the Edge Runtime error when instrumentation
// imports fs/path via supabase.ts.
//
// instrumentation.ts uses dynamic import() to load this file only at
// runtime in Node.js, so fs/path are available.
// =====================================================================

export { prisma } from './supabase';
