// ===== 订单 API =====
// 优先使用 @vercel/postgres 数据库，本地开发降级到 localStorage
import { NextRequest, NextResponse } from "next/server";
import { getPgClient } from "@/lib/db";
import { saveOrders, getOrders, generateId } from "@/lib/store";
import type { ParsedOrder } from "@/lib/types";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const search = searchParams.get("search") || "";
  const page = parseInt(searchParams.get("page") || "0");
  const pageSize = parseInt(searchParams.get("pageSize") || "20");
  const dateFrom = searchParams.get("dateFrom") || "";
  const dateTo = searchParams.get("dateTo") || "";

  const db = await getPgClient();

  if (db) {
    // 确保表存在
    await ensureOrdersTable(db);

    // ---- 数据库模式 ----
    try {
      // Build WHERE conditions
      const conditions: string[] = [];
      const params: any[] = [];
      let paramIdx = 1;

      if (search) {
        conditions.push(`(external_code ILIKE $${paramIdx} OR receiver_name ILIKE $${paramIdx} OR receive_store ILIKE $${paramIdx} OR sku_code ILIKE $${paramIdx})`);
        params.push(`%${search}%`);
        paramIdx++;
      }
      if (dateFrom) {
        conditions.push(`created_at >= $${paramIdx}`);
        params.push(dateFrom);
        paramIdx++;
      }
      if (dateTo) {
        conditions.push(`created_at <= $${paramIdx}`);
        params.push(dateTo + "T23:59:59Z");
        paramIdx++;
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      // Get total count
      const countResult = await db.query(
        `SELECT COUNT(*) as total FROM orders ${whereClause}`,
        params
      );
      const total = parseInt(countResult.rows[0]?.total || "0");

      // Get paged results
      const offset = page * pageSize;
      const dataResult = await db.query(
        `SELECT * FROM orders ${whereClause} ORDER BY created_at DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
        [...params, pageSize, offset]
      );

      // Map DB columns to frontend field names
      const orders = dataResult.rows.map(mapDbRowToFrontend);

      return NextResponse.json({ orders, total, page, pageSize });
    } catch (e: any) {
      console.error("Database query error:", e);
      return NextResponse.json({ error: "Database query failed: " + e.message }, { status: 500 });
    }
  }

  // ---- localStorage fallback ----
  let orders = getOrders();

  if (search) {
    const q = search.toLowerCase();
    orders = orders.filter(
      (o) =>
        (o.外部编码 || "").toLowerCase().includes(q) ||
        (o.收件人姓名 || "").toLowerCase().includes(q) ||
        (o.收货门店 || "").toLowerCase().includes(q) ||
        (o.SKU物品编码 || "").toLowerCase().includes(q)
    );
  }

  const total = orders.length;
  const paged = orders.slice(page * pageSize, (page + 1) * pageSize);

  return NextResponse.json({ orders: paged, total, page, pageSize });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { orders } = body;

  if (!orders || !Array.isArray(orders) || orders.length === 0) {
    return NextResponse.json({ error: "没有可提交的订单数据" }, { status: 400 });
  }

  const batchId = generateId();
  const toSave: ParsedOrder[] = orders.map((o: any) => ({
    ...o,
    外部编码: o.外部编码 || batchId,
  }));

  const db = await getPgClient();

  if (db) {
    // 确保表存在
    await ensureOrdersTable(db);

    // ---- 数据库模式：批量插入 ----
    let successCount = 0;
    let failCount = 0;
    const errors: string[] = [];

    for (const order of toSave) {
      try {
        await db.query(
          `INSERT INTO orders (batch_id, external_code, receive_store, receiver_name, receiver_phone, receiver_address, sku_code, sku_name, sku_quantity, sku_spec, remark, source_file)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            batchId,
            order.外部编码 || null,
            order.收货门店 || null,
            order.收件人姓名 || null,
            order.收件人电话 || null,
            order.收件人地址 || null,
            order.SKU物品编码,
            order.SKU物品名称,
            order.SKU发货数量,
            order.SKU规格型号 || null,
            order.备注 || null,
            order._sourceFile || null,
          ]
        );
        successCount++;
      } catch (e: any) {
        failCount++;
        errors.push(`${order.SKU物品编码}: ${e.message}`);
      }
    }

    return NextResponse.json({
      success: true,
      batchId,
      total: toSave.length,
      successCount,
      failCount,
      errors: errors.length > 0 ? errors : undefined,
    });
  }

  // ---- localStorage fallback ----
  const result = saveOrders(toSave);
  return NextResponse.json({
    success: true,
    batchId,
    total: toSave.length,
    successCount: result.count,
    failCount: 0,
  });
}

// DB row → frontend field mapping
function mapDbRowToFrontend(row: any): ParsedOrder {
  return {
    rowIndex: row.id,
    外部编码: row.external_code || "",
    收货门店: row.receive_store || "",
    收件人姓名: row.receiver_name || "",
    收件人电话: row.receiver_phone || "",
    收件人地址: row.receiver_address || "",
    SKU物品编码: row.sku_code || "",
    SKU物品名称: row.sku_name || "",
    SKU发货数量: row.sku_quantity ?? 0,
    SKU规格型号: row.sku_spec || "",
    备注: row.remark || "",
    _sourceFile: row.source_file || undefined,
    _batchId: row.batch_id || undefined,
    _createdAt: row.created_at || undefined,
  };
}

async function ensureOrdersTable(db: any): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      batch_id TEXT,
      external_code TEXT,
      receive_store TEXT,
      receiver_name TEXT,
      receiver_phone TEXT,
      receiver_address TEXT,
      sku_code TEXT NOT NULL,
      sku_name TEXT NOT NULL,
      sku_quantity INTEGER NOT NULL DEFAULT 0,
      sku_spec TEXT,
      remark TEXT,
      source_file TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}
