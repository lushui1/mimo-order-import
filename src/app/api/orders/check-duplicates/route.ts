import { NextRequest, NextResponse } from "next/server";
import { getPgClient } from "@/lib/db";

/**
 * POST /api/orders/check-duplicates
 * Body: { externalCodes: string[] }
 * Response: { existingCodes: string[], duplicateIndices: Record<string, string> }
 *   existingCodes: 已在数据库中存在的外部编码列表
 *   duplicateWith: 每个编码对应的已有批次ID（用于提示用户）
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { externalCodes } = body;

    if (!externalCodes || !Array.isArray(externalCodes)) {
      return NextResponse.json({ error: "externalCodes must be an array" }, { status: 400 });
    }

    // 过滤空值
    const codes = [...new Set(externalCodes.filter((c: any) => c && typeof c === "string" && c.trim()))];
    if (codes.length === 0) {
      return NextResponse.json({ existingCodes: [], duplicateWith: {} });
    }

    const db = await getPgClient();
    if (!db) {
      // 无数据库时降级：不检测跨批次重复
      console.warn("[check-duplicates] No DB connection, skipping cross-batch check");
      return NextResponse.json({ existingCodes: [], duplicateWith: {}, warning: "数据库未连接，未检测跨批次重复" });
    }

    // 批量查询已存在的外部编码
    const placeholders = codes.map((_, i) => `$${i + 1}`).join(", ");
    const query = `
      SELECT DISTINCT external_code, batch_id
      FROM orders
      WHERE external_code IN (${placeholders})
      AND external_code IS NOT NULL
      AND external_code != ''
    `;

    const result = await db.query(query, codes);

    const existingCodes = result.rows.map((r: any) => r.external_code);
    // 记录每个编码对应的批次ID（取第一个）
    const duplicateWith: Record<string, string> = {};
    result.rows.forEach((r: any) => {
      if (!duplicateWith[r.external_code]) {
        duplicateWith[r.external_code] = r.batch_id;
      }
    });

    console.log(`[check-duplicates] Checked ${codes.length} codes, ${existingCodes.length} already exist in DB`);

    return NextResponse.json({ existingCodes, duplicateWith });
  } catch (e: any) {
    console.error("[check-duplicates] Error:", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
