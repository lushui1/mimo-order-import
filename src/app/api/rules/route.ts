// ===== 规则 API =====
import { NextRequest, NextResponse } from "next/server";
import { getRules, saveRule, deleteRule } from "@/lib/store";
import { getDefaultRules } from "@/lib/rule-engine/presets";

// 获取所有规则 + 加载预置
export async function GET() {
  const rules = getRules();
  if (rules.length === 0) {
    const presets = getDefaultRules();
    presets.forEach((r) => saveRule(r));
  }
  return NextResponse.json(getRules());
}

// 创建/更新规则
export async function POST(req: NextRequest) {
  const body = await req.json();
  
  // 检查同名规则
  if (body.name) {
    const rules = getRules();
    const existing = rules.find(
      (r) => r.name === body.name && r.id !== body.id
    );
    if (existing) {
      return NextResponse.json(
        { error: `规则"${body.name}"已存在` },
        { status: 409 }
      );
    }
  }

  saveRule(body);
  return NextResponse.json({ success: true });
}

// 删除规则
export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }
  deleteRule(id);
  return NextResponse.json({ success: true });
}
