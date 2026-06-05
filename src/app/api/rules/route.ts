// ===== 规则 CRUD API =====
// 规则持久化到数据库，支持创建、读取、更新、删除
import { NextRequest, NextResponse } from "next/server";
import { getPgClient } from "@/lib/db";

const RULES_TABLE = `
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  file_type TEXT NOT NULL DEFAULT 'excel',
  header_row INTEGER NOT NULL DEFAULT 0,
  skip_rows INTEGER NOT NULL DEFAULT 0,
  column_mappings JSONB NOT NULL DEFAULT '[]',
  footer_extraction JSONB,
  aggregation JSONB,
  matrix_transpose JSONB,
  multi_sheet JSONB,
  card_boundary JSONB,
  pdf_config JSONB,
  text_parse JSONB,
  cell_split JSONB,
  ai_generated BOOLEAN DEFAULT false,
  ai_prompt TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
`;

// GET /api/rules — 获取所有规则
export async function GET() {
  const db = await getPgClient();

  if (db) {
    try {
      const result = await db.query(
        `SELECT * FROM rules ORDER BY updated_at DESC`
      );
      const rules = result.rows.map(mapDbRowToRule);
      return NextResponse.json({ rules });
    } catch (e: any) {
      console.error("[Rules API] DB query error:", e);
      return NextResponse.json({ rules: [] });
    }
  }

  return NextResponse.json({ rules: [] });
}

// POST /api/rules — 创建或更新规则
export async function POST(req: NextRequest) {
  const db = await getPgClient();
  if (!db) {
    return NextResponse.json({ error: "数据库不可用" }, { status: 503 });
  }

  try {
    const body = await req.json();
    const { id, name, description, fileType, header, columnMappings,
      footerExtraction, aggregation, matrixTranspose, multiSheet,
      cardBoundary, pdfConfig, textParse, cellSplit, aiGenerated, aiPrompt } = body;

    if (!id || !name) {
      return NextResponse.json({ error: "id 和 name 为必填项" }, { status: 400 });
    }

    await ensureRulesTable(db);

    // Upsert: insert or update
    await db.query(
      `INSERT INTO rules (id, name, description, file_type, header_row, skip_rows, column_mappings,
        footer_extraction, aggregation, matrix_transpose, multi_sheet,
        card_boundary, pdf_config, text_parse, cell_split, ai_generated, ai_prompt)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,$16,$17)
       ON CONFLICT (id) DO UPDATE SET
        name=$2, description=$3, file_type=$4, header_row=$5, skip_rows=$6, column_mappings=$7::jsonb,
        footer_extraction=$8::jsonb, aggregation=$9::jsonb, matrix_transpose=$10::jsonb, multi_sheet=$11::jsonb,
        card_boundary=$12::jsonb, pdf_config=$13::jsonb, text_parse=$14::jsonb, cell_split=$15::jsonb,
        ai_generated=$16, ai_prompt=$17, updated_at=NOW()`,
      [
        id, name, description || "", fileType || "excel",
        header?.headerRow ?? 0, header?.skipRows ?? 0,
        JSON.stringify(columnMappings || []),
        footerExtraction ? JSON.stringify(footerExtraction) : null,
        aggregation ? JSON.stringify(aggregation) : null,
        matrixTranspose ? JSON.stringify(matrixTranspose) : null,
        multiSheet ? JSON.stringify(multiSheet) : null,
        cardBoundary ? JSON.stringify(cardBoundary) : null,
        pdfConfig ? JSON.stringify(pdfConfig) : null,
        textParse ? JSON.stringify(textParse) : null,
        cellSplit ? JSON.stringify(cellSplit) : null,
        aiGenerated || false, aiPrompt || null,
      ]
    );

    return NextResponse.json({ success: true, id });
  } catch (e: any) {
    console.error("[Rules API] Save error:", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// DELETE /api/rules?id=xxx — 删除规则
export async function DELETE(req: NextRequest) {
  const db = await getPgClient();
  if (!db) {
    return NextResponse.json({ error: "数据库不可用" }, { status: 503 });
  }

  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "缺少 id 参数" }, { status: 400 });
  }

  try {
    await ensureRulesTable(db);
    await db.query(`DELETE FROM rules WHERE id = $1`, [id]);
    return NextResponse.json({ success: true });
  } catch (e: any) {
    console.error("[Rules API] Delete error:", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// 确保 rules 表存在
async function ensureRulesTable(db: any): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      file_type TEXT NOT NULL DEFAULT 'excel',
      header_row INTEGER NOT NULL DEFAULT 0,
      skip_rows INTEGER NOT NULL DEFAULT 0,
      column_mappings JSONB NOT NULL DEFAULT '[]',
      footer_extraction JSONB,
      aggregation JSONB,
      matrix_transpose JSONB,
      multi_sheet JSONB,
      card_boundary JSONB,
      pdf_config JSONB,
      text_parse JSONB,
      cell_split JSONB,
      ai_generated BOOLEAN DEFAULT false,
      ai_prompt TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

// DB row → frontend ParseRule
function mapDbRowToRule(row: any): any {
  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    fileType: row.file_type || "excel",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    aiGenerated: row.ai_generated || false,
    aiPrompt: row.ai_prompt || "",
    header: {
      headerRow: row.header_row ?? 0,
      skipRows: row.skip_rows ?? 0,
    },
    columnMappings: row.column_mappings || [],
    footerExtraction: row.footer_extraction || undefined,
    aggregation: row.aggregation || undefined,
    matrixTranspose: row.matrix_transpose || undefined,
    multiSheet: row.multi_sheet || undefined,
    cardBoundary: row.card_boundary || undefined,
    pdfConfig: row.pdf_config || undefined,
    textParse: row.text_parse || undefined,
    cellSplit: row.cell_split || undefined,
  };
}
