import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { verifyAndGetAuthUser } from '@/lib/token';

// GET /api/customer-prices?customerId=xxx
export async function GET(request: NextRequest) {
  try {
    const result = await verifyAndGetAuthUser(
      request.headers.get('authorization'),
      { role: true }
    );
    if (!result) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const customerId = searchParams.get('customerId');
    if (!customerId) {
      return NextResponse.json({ prices: [] });
    }

    const { data } = await db
      .from('customer_prices')
      .select('*')
      .eq('customer_id', customerId)
      .eq('is_active', true);

    return NextResponse.json({ prices: data || [] });
  } catch (error) {
    console.error('Customer prices GET error:', error);
    return NextResponse.json({ prices: [] });
  }
}
