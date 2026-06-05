// ===== 数据库层 =====
// 优先级：@vercel/postgres → pg 直连 → localStorage 降级

import type { Pool } from "pg";

let pgClient: any = null; // @vercel/postgres 的 sql 函数
let pgPool: Pool | null = null; // pg 后备连接池
let dbError: string | null = null;
let backend: "vercel-postgres" | "pg" | "none" = "none";

async function getPgClient() {
  if (pgClient) return pgClient;
  if (pgPool) return createPoolWrapper(pgPool);

  // ---- 策略 1: @vercel/postgres ----
  try {
    console.log("[DB] Trying @vercel/postgres...");
    const { sql } = await import("@vercel/postgres");
    const testResult = await sql`SELECT 1 as connected`;
    console.log("[DB] @vercel/postgres connected:", testResult.rows?.[0]);
    pgClient = sql;
    backend = "vercel-postgres";
    await initTables(sql);
    return sql;
  } catch (e: any) {
    console.warn("[DB] @vercel/postgres failed:", e.message);
  }

  // ---- 策略 2: pg 直连 ----
  try {
    const connStr = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_URL_NON_POOLING;
    if (!connStr) {
      console.warn("[DB] No connection string found (DATABASE_URL/POSTGRES_URL)");
      dbError = "No connection string available";
      return null;
    }
    console.log("[DB] Trying pg direct connection...");
    const { Pool } = await import("pg");
    pgPool = new Pool({
      connectionString: connStr,
      ssl: { rejectUnauthorized: false }, // Vercel/Neon 需要 SSL
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
    const client = await pgPool.connect();
    const testResult = await client.query("SELECT 1 as connected");
    client.release();
    console.log("[DB] pg connected:", testResult.rows?.[0]);
    backend = "pg";
    await initTablesPg(pgPool);
    return createPoolWrapper(pgPool);
  } catch (e: any) {
    dbError = e.message || String(e);
    console.error("[DB] pg connection FAILED:", dbError);
    return null;
  }
}

// ===== 表初始化 =====

async function initTables(sql: any) {
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
  console.log("[DB] Tables ready (vercel-postgres) ✓");
}

async function initTablesPg(pool: Pool) {
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
  console.log("[DB] Tables ready (pg) ✓");
}

// ===== pg Pool 包装器（兼容 @vercel/postgres 的 sql 模板语法）=====

function createPoolWrapper(pool: Pool) {
  return async (strings: TemplateStringsArray | string, ...values: any[]) => {
    // 支持 sql`SELECT * FROM orders` 模板语法
    if (typeof strings === "object" && "raw" in strings) {
      let text = "";
      const params: any[] = [];
      const raw = strings as TemplateStringsArray;
      for (let i = 0; i < raw.length; i++) {
        text += raw[i];
        if (i < values.length) {
          text += `$${params.length + 1}`;
          params.push(values[i]);
        }
      }
      const result = await pool.query(text, params);
      return result;
    }
    // 支持 sql("SELECT * FROM orders") 直接调用
    const result = await pool.query(strings as string, values);
    return result;
  };
}

function getDbStatus() {
  return {
    connected: backend !== "none",
    backend,
    error: dbError,
  };
}

export { getPgClient, getDbStatus };
