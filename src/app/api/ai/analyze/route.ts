// ===== AI 分析 API（服务端）=====
// API Key 仅在服务端使用，不暴露给前端
import { NextRequest, NextResponse } from "next/server";
import { analyzeFileAndGenerateRule } from "@/lib/ai/ai-service";

export async function POST(req: NextRequest) {
  const startTime = Date.now();
  try {
    const body = await req.json();
    const { fileContent, fileName, fileType } = body;

    console.log(`[API /ai/analyze] Received request for ${fileName} (${fileType}), content length=${fileContent?.length || 0}`);

    if (!fileContent || !fileName || !fileType) {
      return NextResponse.json(
        { error: "缺少必要参数：fileContent, fileName, fileType" },
        { status: 400 }
      );
    }

    // 限制文件内容长度，防止超时
    const truncatedContent = fileContent.substring(0, 5000);
    console.log(`[API /ai/analyze] Truncated to ${truncatedContent.length} chars, calling analyze...`);

    const rule = await analyzeFileAndGenerateRule(truncatedContent, fileName, fileType);

    const elapsed = Date.now() - startTime;
    console.log(`[API /ai/analyze] Completed in ${elapsed}ms, rule has ${rule.columnMappings?.length || 0} mappings`);

    return NextResponse.json({ success: true, rule });
  } catch (e: any) {
    const elapsed = Date.now() - startTime;
    console.error(`[API /ai/analyze] Error after ${elapsed}ms:`, e);
    return NextResponse.json(
      { error: e.message || "AI 分析失败" },
      { status: 500 }
    );
  }
}
