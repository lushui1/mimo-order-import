import { NextRequest, NextResponse } from 'next/server';
export async function POST(req, { params }) {
  try {
    const { id } = await params;
    const body = await req.json();
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    const o = await prisma.order.findUnique({ where: { id } });
    if (!o) return NextResponse.json({ error: '运单不存在' }, { status: 404 });
    console.log('[V2] Anomaly:', { id, status: body.status, ticketNo: body.ticketNo });
    return NextResponse.json({ success: true });
  } catch (e) { return NextResponse.json({ error: e.message }, { status: 500 }); }
}