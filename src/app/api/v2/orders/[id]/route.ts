import { NextRequest, NextResponse } from 'next/server';
export async function GET(req, { params }) {
  try {
    const { id } = await params;
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    const o = await prisma.order.findUnique({ where: { id } });
    if (!o) return NextResponse.json({ error: '运单不存在' }, { status: 404 });
    return NextResponse.json({ id: o.id, externalCode: o.externalCode, receiverStore: o.receiverStore, receiverName: o.receiverName, receiverPhone: o.receiverPhone, receiverAddress: o.receiverAddress, totalAmount: 0, skuCode: o.skuCode, skuName: o.skuName, skuQuantity: o.skuQuantity, skuSpec: o.skuSpec, remark: o.remark });
  } catch (e) { return NextResponse.json({ error: e.message }, { status: 500 }); }
}