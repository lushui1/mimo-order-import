// ===== 数据库层 =====
// 使用 @vercel/postgres 支持 Vercel 部署，本地开发降级到 localStorage

let pgClient: any = null;

async function getPgClient() {
  if (pgClient) return pgClient;
  try {
    const { sql } = await import("@vercel/postgres");
    pgClient = sql;
    // 初始化表
    await sql`
      CREATE TABLE IF NOT EXISTS parse_rules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        file_type TEXT NOT NULL DEFAULT 'excel',
        config JSONB NOT NULL DEFAULT '{}',
        ai_generated BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        batch_id TEXT NOT NULL,
        external_code TEXT,
        receive_store TEXT,
        receiver_name TEXT,
        receiver_phone TEXT,
        receiver_address TEXT,
        sku_code TEXT NOT NULL,
        sku_name TEXT NOT NULL,
        sku_quantity REAL NOT NULL DEFAULT 0,
        sku_spec TEXT,
        remark TEXT,
        source_file TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    return sql;
  } catch (e) {
    console.warn("Database not available, using localStorage fallback:", e);
    return null;
  }
}

export { getPgClient };
