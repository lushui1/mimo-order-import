// ===== 数据库健康检查 + 诊断 =====
import { NextResponse } from "next/server";
import { getPgClient, getDbStatus } from "@/lib/db";

export async function GET() {
  // 先触发连接
  const db = await getPgClient();
  const status = getDbStatus();

  if (!db) {
    return NextResponse.json({
      status: "degraded",
      db: "disconnected",
      backend: status.backend,
      error: status.error || "unknown",
      env: {
        DATABASE_URL: !!process.env.DATABASE_URL,
        POSTGRES_URL: !!process.env.POSTGRES_URL,
        POSTGRES_URL_NON_POOLING: !!process.env.POSTGRES_URL_NON_POOLING,
      },
      message: "数据库未连接",
    }, { status: 200 });
  }

  try {
    const result = await db`SELECT COUNT(*) as count FROM orders`;
    return NextResponse.json({
      status: "healthy",
      db: "connected",
      backend: status.backend,
      orderCount: result.rows?.[0]?.count || 0,
    });
  } catch (e: any) {
    return NextResponse.json({
      status: "error",
      db: "connected",
      backend: status.backend,
      error: e.message || String(e),
    }, { status: 500 });
  }
}
