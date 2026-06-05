const { Pool } = require('pg');
const pool = new Pool({
  connectionString: 'postgresql://neondb_owner:npg_M2f8XjNBQuoR@ep-restless-cell-ap81r22c-pooler.c-7.us-east-1.aws.neon.tech/neondb?sslmode=require',
  connectionTimeoutMillis: 10000,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  try {
    const r = await pool.query('SELECT 1 as connected, NOW() as time');
    console.log('CONNECTED:', JSON.stringify(r.rows[0]));
    
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
    console.log('Table orders OK');
    
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
    console.log('Table parse_rules OK');
    console.log('ALL DONE - Neon DB ready');
  } catch (e) {
    console.error('FAIL:', e.message);
  } finally {
    await pool.end();
  }
}
main();
