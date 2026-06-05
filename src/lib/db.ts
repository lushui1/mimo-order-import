// ===== 数据库层 =====
// 直接使用 pg 连接 Neon PostgreSQL，不做 @vercel/postgres 试探

import type { Pool } from "pg";

let pgPool: Pool | null = null;
let dbError: string | null = null;

function getConnStr(): string {
  let conn = (process.env.DATABASE_URL ||
              process.env.POSTGRES_URL ||
              process.env.POSTGRES_URL_NON_POOLING ||
              "");
  if (!conn) return "";

  // 正确清理 Neon 特有参数 channel_binding=require，保留 ? 或 & 分隔符
  if (conn.includes("?channel_binding=require&")) {
    conn = conn.replace(/\?channel_binding=require&/, "?");
  } else if (conn.includes("?channel_binding=require")) {
    conn = conn.replace(/\?channel_binding=require/, "");
  } else if (conn.includes("&channel_binding=require&")) {
    conn = conn.replace(/&channel_binding=require&/, "&");
  } else if (conn.includes("&channel_binding=require")) {
    conn = conn.replace(/&channel_binding=require/, "");
  }

  // 清理可能残留的 ?& 或末尾的 ? 或 &
  conn = conn.replace(/\?&/, "?");
  conn = conn.replace(/[?&]$/, "");

  console.log("[DB] Connection string (sanitized):", conn.replace(/\/\/.*@/, "//***@"));
  return conn;
}

async function getPgClient() {
  if (pgPool) return createPoolWrapper(pgPool);

  const connStr = getConnStr();
  if (!connStr) {
    dbError = "No connection string (DATABASE_URL/POSTGRES_URL)";
    console.error("[DB]", dbError);
    return null;
  }

  try {
    console.log("[DB] Connecting to Neon PostgreSQL...");
    const { Pool: PgPool } = await import("pg");
    pgPool = new PgPool({
      connectionString: connStr,
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
    const client = await pgPool.connect();
    const test = await client.query("SELECT 1 as connected, NOW() as time");
    client.release();
    console.log("[DB] Connected:", JSON.stringify(test.rows?.[0]));

    await initTables(pgPool);
    console.log("[DB] Tables ready");
    return createPoolWrapper(pgPool);
  } catch (e: any) {
    dbError = e.message || String(e);
    console.error("[DB] Connection FAILED:", dbError);
    return null;
  }
}

// ===== 表初始化 =====
async function initTables(pool: Pool) {
  await pool.query(`
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
  `);
  await pool.query(`
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
  `);
}

// ===== pg Pool → sql 模板包装器 =====
function createPoolWrapper(pool: Pool) {
  const wrapper = async (strings: TemplateStringsArray | string, ...values: any[]) => {
    if (typeof strings === "object" && "raw" in strings) {
      let text = "";
      const params: any[] = [];
      for (let i = 0; i < strings.length; i++) {
        text += strings[i];
        if (i < values.length) {
          text += `$${params.length + 1}`;
          params.push(values[i]);
        }
      }
      return pool.query(text, params);
    }
    return pool.query(strings as string, values);
  };
  // 兼容 db.query(text, params) 调用
  wrapper.query = (text: string, params?: any[]) => pool.query(text, params || []);
  return wrapper;
}

function getDbStatus() {
  return {
    connected: pgPool !== null,
    backend: pgPool ? "pg" : "none",
    error: dbError,
  };
}

export { getPgClient, getDbStatus };
