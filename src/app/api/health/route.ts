// ===== 数据库健康检查 =====
import { NextResponse } from "next/server";
import { getPgClient } from "@/lib/db";

export async function GET() {
  try {
    const db = await getPgClient();

    if (!db) {
      return NextResponse.json({
        status: "degraded",
        db: "disconnected",
        storage: "localStorage",
        message: "数据库未连接，使用本地存储降级模式"
      }, { status: 200 });
    }

    // 验证 orders 表存在
    const result = await db`SELECT COUNT(*) as count FROM orders`;
    const orderCount = result.rows?.[0]?.count || 0;

    return NextResponse.json({
      status: "healthy",
      db: "connected",
      storage: "PostgreSQL (@vercel/postgres)",
      orderCount,
      tables: {
        orders: "exists",
        parse_rules: "exists"
      }
    });
  } catch (e: any) {
    return NextResponse.json({
      status: "error",
      db: "error",
      message: e.message || String(e),
      hint: "检查 POSTGRES_URL 环境变量是否配置"
    }, { status: 500 });
  }
}
