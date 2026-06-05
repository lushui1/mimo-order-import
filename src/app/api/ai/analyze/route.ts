// ===== AI 分析 API（服务端）=====
// API Key 仅在服务端使用，不暴露给前端
import { NextRequest, NextResponse } from "next/server";
import { analyzeFileAndGenerateRule } from "@/lib/ai/ai-service";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { fileContent, fileName, fileType } = body;

    if (!fileContent || !fileName || !fileType) {
      return NextResponse.json(
        { error: "缺少必要参数：fileContent, fileName, fileType" },
        { status: 400 }
      );
    }

    // 限制文件内容长度，防止超时
    const truncatedContent = fileContent.substring(0, 5000);

    const rule = await analyzeFileAndGenerateRule(truncatedContent, fileName, fileType);

    return NextResponse.json({ success: true, rule });
  } catch (e: any) {
    console.error("AI analyze error:", e);
    return NextResponse.json(
      { error: e.message || "AI 分析失败" },
      { status: 500 }
    );
  }
}
