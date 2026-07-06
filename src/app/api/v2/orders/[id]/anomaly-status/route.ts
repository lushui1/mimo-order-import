import { getPgClient } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';

export async function POST(req, { params }) {
  try {
    const { id } = await params;
    const body = await req.json();
    const db = await getPgClient();
    if (!db) return NextResponse.json({ error: 'Database not available' }, { status: 503 });
    const result = await db.query('SELECT * FROM orders WHERE id = $1', [id]);
    if (result.rows.length === 0) return NextResponse.json({ error: '运单不存在' }, { status: 404 });
    console.log('[V2] Anomaly writeback:', { orderId: id, status: body.status, ticketNo: body.ticketNo });
    return NextResponse.json({ success: true });
  } catch (e) { return NextResponse.json({ error: e.message }, { status: 500 }); }
}