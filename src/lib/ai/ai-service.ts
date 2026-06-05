// ===== AI 大模型服务（服务端专用）=====
// 用于分析文件结构并生成推荐解析规则
// API Key 仅在服务端环境变量中使用，不暴露给前端

import type { ParseRule } from "../types";
import { generateId } from "../store";

// 服务端环境变量（不带 NEXT_PUBLIC_ 前缀）
const API_BASE = process.env.AI_API_BASE_URL || process.env.AI_API_URL || process.env.NEXT_PUBLIC_AI_API_URL || "https://api.deepseek.com/v1";
const API_KEY = process.env.AI_API_KEY || process.env.NEXT_PUBLIC_AI_API_KEY || "";
const AI_MODEL = process.env.AI_MODEL || "mimo-v2.5-pro";

export async function analyzeFileAndGenerateRule(
  fileContent: string,
  fileName: string,
  fileType: string
): Promise<Partial<ParseRule>> {
  // If no API key configured, use local heuristic analysis
  if (!API_KEY) {
    console.log("[AI] No API key, using local analysis");
    return localAnalyze(fileContent, fileName, fileType);
  }

  try {
    const prompt = buildAnalysisPrompt(fileContent, fileName, fileType);
    
    console.log(`[AI] Calling ${AI_MODEL} at ${API_BASE}...`);
    const startTime = Date.now();
    
    // 15秒超时保护
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    
    const response = await fetch(`${API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [
          {
            role: "system",
            content: `你是物流出库单解析专家。根据文件内容生成JSON规则配置。

文件格式: 每行 "行N: 值1 | 值2 | 值3 | ..."
sourceField 取纯净列名（不含"行N: "前缀）

返回JSON结构:
{"header":{"skipRows":数字,"headerRow":数字},"columnMappings":[{"sourceField":"列名","targetField":"目标","isRequired":bool,"transform":"toNumber"(可选),"aiConfidence":0.8}]}

可选targetField: 外部编码,收货门店,收件人姓名,收件人电话,收件人地址,SKU物品编码,SKU物品名称,SKU发货数量,SKU规格型号,备注

补充检测(可选): footerExtraction(尾部信息), aggregation(跨行聚合), matrixTranspose(矩阵转置), multiSheet(多Sheet), cardBoundary(卡片式), pdfConfig(PDF配置)

只返回JSON，无其他文字。`,
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.1,
        max_tokens: 2000,
      }),
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    
    const elapsed = Date.now() - startTime;
    console.log(`[AI] Response in ${elapsed}ms, status=${response.status}`);

    if (!response.ok) throw new Error(`API Error: ${response.status}`);

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || "";

    // Extract JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    throw new Error("No valid JSON in response");
  } catch (error: any) {
    console.error("AI service error, falling back to local analysis:", error.message);
    return localAnalyze(fileContent, fileName, fileType);
  }
}

// ===== 本地启发式分析（无 API Key 时的后备方案）=====
// 基于文件内容结构自动检测，不依赖文件名
function localAnalyze(
  fileContent: string,
  fileName: string,
  fileType: string
): Partial<ParseRule> {
  const rule: Partial<ParseRule> = {
    fileType: fileType as any,
    header: { skipRows: 0, headerRow: 0 },
    columnMappings: [],
  };

  const lines = fileContent.split("\n").map((l) => l.trim()).filter(Boolean);
  const firstLine = lines[0] || "";
  const secondLine = lines[1] || "";

  // ---- 按文件类型分支 ----

  if (fileType === "pdf") {
    // PDF 通用分析
    rule.pdfConfig = {
      headerSkipLines: 5,
      tableHeaderPattern: detectTableHeader(lines),
      footerKeyword: "收货人",
    };
    rule.columnMappings = [
      { sourceField: "", targetField: "SKU物品编码", aiConfidence: 0.7 },
      { sourceField: "", targetField: "SKU物品名称", aiConfidence: 0.7 },
      { sourceField: "", targetField: "SKU发货数量", isRequired: true, transform: "toNumber", aiConfidence: 0.7 },
      { sourceField: "规格型号", targetField: "SKU规格型号", aiConfidence: 0.6 },
    ];
    rule.header = { skipRows: 1, headerRow: 1 };
    rule.footerExtraction = {
      enabled: true,
      sections: [
        {
          name: "收货信息",
          startKeyword: "收货人",
          fields: [
            { keyword: "收货人", targetField: "收件人姓名", offset: 1 },
            { keyword: "收货电话", targetField: "收件人电话", offset: 1 },
            { keyword: "收货地址", targetField: "收件人地址", offset: 0 },
          ],
        },
      ],
    };
    return rule;
  }

  if (fileType === "word") {
    // Word 纯文本解析
    const hasSeparator = lines.some((l) => l.includes("━") || l.includes("===") || l.includes("---"));
    if (hasSeparator) {
      rule.textParse = {
        enabled: true,
        recordSeparator: detectSeparator(lines),
        fieldPatterns: [
          { name: "编码", targetField: "SKU物品编码", pattern: "编码[：:]\\s*(\\S+)", extractGroup: 1 },
          { name: "名称", targetField: "SKU物品名称", pattern: "名称[：:]\\s*(\\S+)", extractGroup: 1 },
          { name: "数量", targetField: "SKU发货数量", pattern: "数量[：:]\\s*(\\d+)", extractGroup: 1 },
          { name: "规格", targetField: "SKU规格型号", pattern: "规格[：:]\\s*(\\S+)", extractGroup: 1 },
          { name: "收货人", targetField: "收件人姓名", pattern: "收货人[：:]\\s*(\\S+)", extractGroup: 1 },
          { name: "电话", targetField: "收件人电话", pattern: "电话[：:]\\s*(\\S+)", extractGroup: 1 },
          { name: "地址", targetField: "收件人地址", pattern: "地址[：:]\\s*(.+)", extractGroup: 1 },
        ],
      };
    }
    return rule;
  }

  // ---- Excel 分析 ----
  // 检测表头行（查找包含"编码"或"名称"的行）
  // 注意：rawFileToText 给每行加了"行N: "前缀，需要剥离
  let headerRowIdx = 0;
  for (let i = 0; i < Math.min(10, lines.length); i++) {
    // Strip "行N: " prefix added by rawFileToText
    const cleanLine = lines[i].replace(/^行\d+:\s*/, "").toLowerCase();
    if (cleanLine.includes("编码") || cleanLine.includes("名称") || cleanLine.includes("数量")) {
      headerRowIdx = i;
      break;
    }
  }
  rule.header = { skipRows: headerRowIdx, headerRow: headerRowIdx };

  // 分析表头列（剥离"行N: "前缀后再按 | 拆分）
  const headerLine = (lines[headerRowIdx] || "").replace(/^行\d+:\s*/, "");
  const columns = headerLine.split(/\s*\|\s*/).map((c) => c.trim()).filter(Boolean);

  if (columns.length === 0) {
    console.warn("localAnalyze: Could not extract columns from header line:", headerLine);
  }

  // 自动映射列（使用剥离前缀后的纯净列名）
  const mappings: any[] = [];
  columns.forEach((col) => {
    const cl = col.toLowerCase().replace(/[*\s]/g, "");
    if (cl.includes("编码") && !cl.includes("sku") && !cl.includes("物品")) {
      mappings.push({ sourceField: col, targetField: "外部编码", aiConfidence: 0.7 });
    } else if (cl.includes("门店") || cl.includes("机构") || cl.includes("收货")) {
      mappings.push({ sourceField: col, targetField: "收货门店", aiConfidence: 0.7 });
    } else if (cl.includes("物品编码") || cl.includes("sku编码") || cl === "编码") {
      mappings.push({ sourceField: col, targetField: "SKU物品编码", isRequired: true, aiConfidence: 0.8 });
    } else if (cl.includes("物品名称") || cl.includes("sku名称") || cl === "名称") {
      mappings.push({ sourceField: col, targetField: "SKU物品名称", isRequired: true, aiConfidence: 0.8 });
    } else if (cl.includes("数量") || cl.includes("发货") || cl.includes("出库")) {
      mappings.push({ sourceField: col, targetField: "SKU发货数量", isRequired: true, transform: "toNumber", aiConfidence: 0.8 });
    } else if (cl.includes("规格") || cl.includes("型号")) {
      mappings.push({ sourceField: col, targetField: "SKU规格型号", aiConfidence: 0.7 });
    } else if (cl.includes("备注")) {
      mappings.push({ sourceField: col, targetField: "备注", aiConfidence: 0.6 });
    }
  });

  // 检测是否需要跨行聚合（看是否有"配送单号"或"单号"列）
  const hasGroupBy = columns.some((c) => c.includes("单号") || c.includes("配送"));
  if (hasGroupBy) {
    const groupCol = columns.find((c) => c.includes("单号") || c.includes("配送")) || "";
    rule.aggregation = {
      enabled: true,
      groupByField: groupCol,
      sharedFields: ["收件人姓名", "收件人电话", "收件人地址", "收货门店"],
    };
    // 添加收货人相关映射
    columns.forEach((col) => {
      const cl = col.toLowerCase();
      if (cl.includes("收货人") || cl.includes("收件人")) {
        mappings.push({ sourceField: col, targetField: "收件人姓名", aiConfidence: 0.8 });
      } else if (cl.includes("电话") || cl.includes("手机")) {
        mappings.push({ sourceField: col, targetField: "收件人电话", aiConfidence: 0.8 });
      } else if (cl.includes("地址")) {
        mappings.push({ sourceField: col, targetField: "收件人地址", aiConfidence: 0.8 });
      }
    });
  }

  // 检测是否有尾部收货信息（在数据区之后）
  // 注意剥离"行N: "前缀
  const dataEndIdx = lines.findIndex((l, i) =>
    i > headerRowIdx + 2 &&
    (l.replace(/^行\d+:\s*/, "").includes("合计") || l.replace(/^行\d+:\s*/, "").includes("总计"))
  );
  if (dataEndIdx > 0) {
    const footerLines = lines.slice(dataEndIdx);
    const hasFooterReceiver = footerLines.some((l) => l.includes("收货人") || l.includes("收件人"));
    if (hasFooterReceiver) {
      rule.footerExtraction = {
        enabled: true,
        sections: [
          {
            name: "收货信息",
            startKeyword: "收货人",
            fields: [
              { keyword: "收货人", targetField: "收件人姓名", offset: 1, aiConfidence: 0.8 },
              { keyword: "电话", targetField: "收件人电话", offset: 1, aiConfidence: 0.8 },
              { keyword: "地址", targetField: "收件人地址", offset: 1, aiConfidence: 0.8 },
            ],
          },
        ],
      };
    }
  }

  // 检测是否为矩阵转置（列头包含门店名等维度）
  const dimensionCols = columns.filter((c) =>
    c.includes("店") || c.includes("仓") || c.includes("周一") || c.includes("周二")
  );
  if (dimensionCols.length >= 2) {
    const dimColIndices = dimensionCols.map((dc) => columns.indexOf(dc)).filter((i) => i >= 0);
    rule.matrixTranspose = {
      enabled: true,
      dimensionColumns: dimColIndices,
      dimensionField: "收货门店",
      quantityField: "SKU发货数量",
      excludeEmpty: true,
    };
  }

  // 检测是否为多Sheet（文件名包含"多门店"或"分Sheet"）
  if (fileName.includes("多门店") || fileName.includes("分Sheet") || fileName.includes("Sheet")) {
    rule.multiSheet = { enabled: true, extractStoreName: true };
  }

  rule.columnMappings = mappings;
  return rule;
}

// 检测表格表头模式
function detectTableHeader(lines: string[]): string {
  for (const line of lines) {
    if (line.includes("物品类别") || line.includes("序号") || line.includes("物品编码")) {
      return line.substring(0, 20);
    }
  }
  return "序号";
}

// 检测文本分隔符
function detectSeparator(lines: string[]): string {
  for (const line of lines) {
    if (line.includes("━")) return "━".repeat(10);
    if (line.includes("===")) return "===";
    if (line.match(/^-{5,}$/)) return "---";
  }
  return "---";
}

// ===== 构建 AI Prompt（精简版，加速响应）=====
function buildAnalysisPrompt(
  fileContent: string,
  fileName: string,
  fileType: string
): string {
  return `文件名: ${fileName} (${fileType})
文件内容（前40行，格式: 行N: 列1 | 列2 | ...）:
${fileContent.substring(0, 2000)}

请返回JSON规则，识别: 表头行号、列映射(SKU编码/名称/数量=必填)、尾部收货信息、跨行聚合、矩阵转置、多Sheet。`;
}
