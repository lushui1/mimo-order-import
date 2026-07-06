import { NextRequest, NextResponse } from 'next/server';
export async function GET(req, { params }) {
  try {
    const { id } = await params;
    const skuCode = new URL(req.url).searchParams.get('skuCode');
    if (!skuCode) return NextResponse.json({ error: 'missing skuCode' }, { status: 400 });
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    const o = await prisma.order.findUnique({ where: { id } });
    if (!o) return NextResponse.json({ error: '运单不存在' }, { status: 404 });
    const exists = o.skuCode === skuCode;
    return NextResponse.json({ exists, skuInfo: exists ? { skuCode: o.skuCode, skuName: o.skuName, quantity: o.skuQuantity, spec: o.skuSpec } : null });
  } catch (e) { return NextResponse.json({ error: e.message }, { status: 500 }); }
}