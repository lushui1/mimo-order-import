import { getPgClient } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(req) {
  try {
    const url = new URL(req.url);
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('pageSize') || '50')));
    const db = await getPgClient();
    if (!db) return NextResponse.json({ error: 'Database not available' }, { status: 503 });
    const countResult = await db.query('SELECT COUNT(*) as total FROM orders');
    const total = parseInt(countResult.rows[0]?.total || '0');
    const offset = (page - 1) * pageSize;
    const result = await db.query('SELECT * FROM orders ORDER BY created_at DESC LIMIT $1 OFFSET $2', [pageSize, offset]);
    const orders = result.rows.map(o => ({
      id: String(o.id),
      externalCode: o.external_code,
      receiverStore: o.receive_store,
      receiverName: o.receiver_name,
      receiverPhone: o.receiver_phone,
      receiverAddress: o.receiver_address,
      totalAmount: 0,
      skuCode: o.sku_code,
      skuName: o.sku_name,
      skuQuantity: String(o.sku_quantity),
      skuSpec: o.sku_spec,
      remark: o.remark,
    }));
    return NextResponse.json({ orders, total, page, pageSize, totalPages: Math.ceil(total / pageSize) });
  } catch (e) { return NextResponse.json({ error: e.message }, { status: 500 }); }
}