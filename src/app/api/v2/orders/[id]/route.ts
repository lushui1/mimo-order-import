import { getPgClient } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(req, { params }) {
  try {
    const { id } = await params;
    const db = await getPgClient();
    if (!db) return NextResponse.json({ error: 'Database not available' }, { status: 503 });
    const result = await db.query('SELECT * FROM orders WHERE id = $1', [id]);
    if (result.rows.length === 0) return NextResponse.json({ error: '运单不存在' }, { status: 404 });
    const o = result.rows[0];
    return NextResponse.json({
      id: String(o.id), externalCode: o.external_code,
      receiverStore: o.receive_store, receiverName: o.receiver_name,
      receiverPhone: o.receiver_phone, receiverAddress: o.receiver_address,
      totalAmount: 0, skuCode: o.sku_code, skuName: o.sku_name,
      skuQuantity: String(o.sku_quantity), skuSpec: o.sku_spec, remark: o.remark,
    });
  } catch (e) { return NextResponse.json({ error: e.message }, { status: 500 }); }
}