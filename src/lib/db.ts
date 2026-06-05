// ===== 数据库层 =====
// 使用 @vercel/postgres 支持 Vercel 部署，本地开发降级到 localStorage

let pgClient: any = null;
let dbError: string | null = null;

async function getPgClient() {
  if (pgClient) return pgClient;
  try {
    console.log("[DB] Connecting to PostgreSQL...");
    console.log("[DB] POSTGRES_URL exists:", !!process.env.POSTGRES_URL);
    console.log("[DB] DATABASE_URL exists:", !!process.env.DATABASE_URL);
    
    const { sql } = await import("@vercel/postgres");
    
    // 验证连接
    const testResult = await sql`SELECT 1 as connected`;
    console.log("[DB] Connection test:", testResult.rows?.[0]);
    
    pgClient = sql;
    
    // 初始化表
    console.log("[DB] Creating tables...");
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
    console.log("[DB] Tables ready ✓");
    
    // 清空错误标记
    dbError = null;
    return sql;
  } catch (e: any) {
    dbError = e.message || String(e);
    console.error("[DB] Connection FAILED:", dbError);
    console.error("[DB] Stack:", e.stack);
    return null;
  }
}

function getDbStatus() {
  return {
    connected: !!pgClient,
    error: dbError,
  };
}

export { getPgClient, getDbStatus };
