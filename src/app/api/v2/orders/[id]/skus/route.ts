import { getPgClient } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(req, { params }) {
  try {
    const { id } = await params;
    const skuCode = new URL(req.url).searchParams.get('skuCode');
    if (!skuCode) return NextResponse.json({ error: 'missing skuCode' }, { status: 400 });
    const db = await getPgClient();
    if (!db) return NextResponse.json({ error: 'Database not available' }, { status: 503 });
    const result = await db.query('SELECT * FROM orders WHERE id = $1', [id]);
    if (result.rows.length === 0) return NextResponse.json({ error: '运单不存在' }, { status: 404 });
    const o = result.rows[0];
    const exists = o.sku_code === skuCode;
    return NextResponse.json({
      exists,
      skuInfo: exists ? { skuCode: o.sku_code, skuName: o.sku_name, quantity: String(o.sku_quantity), spec: o.sku_spec } : null,
    });
  } catch (e) { return NextResponse.json({ error: e.message }, { status: 500 }); }
}