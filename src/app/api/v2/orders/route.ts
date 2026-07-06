import { NextRequest, NextResponse } from 'next/server';
export async function GET(req) {
  try {
    const url = new URL(req.url);
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('pageSize') || '50')));
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    const [orders, total] = await Promise.all([
      prisma.order.findMany({ orderBy: { createdAt: 'desc' }, skip: (page-1)*pageSize, take: pageSize }),
      prisma.order.count(),
    ]);
    return NextResponse.json({
      orders: orders.map(o => ({ id: o.id, externalCode: o.externalCode, receiverStore: o.receiverStore, receiverName: o.receiverName, receiverPhone: o.receiverPhone, receiverAddress: o.receiverAddress, totalAmount: 0, skuCode: o.skuCode, skuName: o.skuName, skuQuantity: o.skuQuantity, skuSpec: o.skuSpec, remark: o.remark })),
      total, page, pageSize, totalPages: Math.ceil(total/pageSize),
    });
  } catch (e) { return NextResponse.json({ error: e.message }, { status: 500 }); }
}