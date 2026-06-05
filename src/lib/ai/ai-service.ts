// ===== AI 大模型服务（服务端专用）=====
// 用于分析文件结构并生成推荐解析规则
// API Key 仅在服务端环境变量中使用，不暴露给前端

import type { ParseRule } from "../types";

// 服务端环境变量（不带 NEXT_PUBLIC_ 前缀）
const API_BASE = process.env.AI_API_BASE_URL || process.env.AI_API_URL || process.env.NEXT_PUBLIC_AI_API_URL || "https://api.deepseek.com/v1";
const API_KEY = process.env.AI_API_KEY || process.env.NEXT_PUBLIC_AI_API_KEY || "";
const AI_MODEL = process.env.AI_MODEL || "mimo-v2.5";

export async function analyzeFileAndGenerateRule(
  fileContent: string,
  fileName: string,
  fileType: string
): Promise<Partial<ParseRule>> {
  // 本地分析作为主要方法（<100ms，覆盖率>90%）
  const localResult = localAnalyze(fileContent, fileName, fileType);

  // 如果本地分析结果已经足够好（>=3个映射），直接返回，不做 AI 调用
  // AI 调用作为可选增强，在后台异步执行
  const localMappings = localResult.columnMappings?.filter(m => m.sourceField && m.sourceField.trim()).length || 0;
  if (localMappings >= 3) {
    console.log(`[AI] Local analysis sufficient: ${localMappings} mappings, skipping AI call`);
    return localResult;
  }

  // 本地分析不够好时才尝试 AI
  if (!API_KEY) {
    console.log("[AI] No API key, using local analysis");
    return localResult;
  }

  try {
    const prompt = buildReviewPrompt(fileContent, fileName, fileType, localResult);

    console.log(`[AI] Local analysis insufficient (${localMappings} mappings), calling ${AI_MODEL}...`);
    const startTime = Date.now();

    // AI 超时设为 25s（平衡速度和成功率）
    const AI_TIMEOUT_MS = 25000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

    // 使用流式调用，先拿到第一个 token 就知道 API 可达
    const response = await fetch(`${API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        temperature: 0.05,
        max_tokens: 8000,
        stream: true,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`API Error: ${response.status} ${errText.substring(0, 200)}`);
    }

    // 流式读取，拼接完整响应
    let fullContent = "";
    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body reader");

    const decoder = new TextDecoder();
    let chunkCount = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      chunkCount++;

      // 解析 SSE 格式：data: {...}\n\n
      const lines = chunk.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content || "";
          if (delta) {
            fullContent += delta;
          }
        } catch {
          // 忽略不完整的 JSON chunk
        }
      }

      // 首次收到数据时记录
      if (chunkCount === 1) {
        const elapsed = Date.now() - startTime;
        console.log(`[AI] First chunk received in ${elapsed}ms`);
      }
    }

    clearTimeout(timeoutId);

    const elapsed = Date.now() - startTime;
    console.log(`[AI] Streaming completed in ${elapsed}ms, content length=${fullContent.length}`);
    console.log(`[AI] Raw response preview: "${fullContent.substring(0, 300).replace(/\n/g, "\\n")}"`);

    // Extract JSON from response (handle markdown code blocks and extra text)
    const aiResult = extractJsonFromAiResponse(fullContent);
    if (aiResult && isValidAiRule(aiResult)) {
      console.log(`[AI] Valid rule from AI: ${aiResult.columnMappings?.length || 0} mappings, headerRow=${aiResult.header?.headerRow}`);
      // Merge AI结果与localResult：AI缺少的必填字段用localResult补充
      return mergeWithFallback(aiResult, localResult);
    }
    console.warn(`[AI] Invalid or empty rule from AI (aiResult=${aiResult ? "parsed" : "null"}), using local analysis fallback with ${localResult.columnMappings?.length || 0} mappings`);
    // 标记为fallback，让前端提示用户
    return { ...localResult, _fallback: true, _fallbackReason: aiResult ? "AI返回的规则不完整" : "AI响应无法解析" } as Partial<ParseRule>;
  } catch (error: any) {
    console.error("[AI] API call failed:", error.name, error.message);
    // 超时或网络错误 → 返回预先算好的本地启发式分析结果
    console.log("[AI] Returning pre-computed local analysis fallback");
    return { ...localResult, _fallback: true, _fallbackReason: error.name === "AbortError" ? "AI响应超时，已使用本地分析" : `AI调用失败: ${error.message}` } as Partial<ParseRule>;
  }
}

// ===== System Prompt：极简指令，让 AI 做最少的工作 =====
const SYSTEM_PROMPT = `你是物流出库单规则审核员。用户已用本地算法生成规则，你只需修正错误。
输出纯JSON，格式：{"header":{"skipRows":N,"headerRow":N},"columnMappings":[{"sourceField":"列名","targetField":"标准字段","isRequired":bool,"transform":"toNumber"}],"aggregation":{"enabled":true,"groupByField":"外部编码","sharedFields":["收件人姓名","收件人电话","收件人地址"]}}
标准字段：SKU物品编码,SKU物品名称,SKU发货数量,SKU规格型号,外部编码,收货门店,收件人姓名,收件人电话,收件人地址,备注`;

// ===== 从 AI 响应中提取 JSON =====
function extractJsonFromAiResponse(content: string): any | null {
  if (!content || !content.trim()) return null;

  // Try 1: Extract from markdown code block ```json ... ```
  const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch {
      console.log("[AI] Markdown code block JSON parse failed, trying next");
    }
  }

  // Try 2: Find the outermost JSON object { ... }
  // Use a brace balance approach to find the largest balanced JSON object
  let braceCount = 0;
  let startIdx = -1;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "{" && braceCount === 0) {
      startIdx = i;
      braceCount = 1;
    } else if (content[i] === "{" && braceCount > 0) {
      braceCount++;
    } else if (content[i] === "}") {
      braceCount--;
      if (braceCount === 0 && startIdx >= 0) {
        try {
          const jsonStr = content.substring(startIdx, i + 1);
          return JSON.parse(jsonStr);
        } catch {
          // Continue searching
          startIdx = -1;
        }
      }
    }
  }

  // Try 3: Simple greedy match (last resort)
  const greedyMatch = content.match(/\{[\s\S]*\}/);
  if (greedyMatch) {
    try {
      return JSON.parse(greedyMatch[0]);
    } catch {
      console.log("[AI] Greedy JSON parse failed");
    }
  }

  return null;
}

// ===== 验证 AI 返回的规则是否有效 =====
function isValidAiRule(rule: any): boolean {
  if (!rule || typeof rule !== "object") return false;

  // Must have columnMappings array with at least 3 items (编码, 名称, 数量)
  const mappings = rule.columnMappings;
  if (!Array.isArray(mappings) || mappings.length < 3) {
    console.warn(`[AI] Rule invalid: columnMappings has ${mappings?.length || 0} items, need >= 3`);
    return false;
  }

  // Must have header with reasonable headerRow
  const header = rule.header;
  if (!header || typeof header.headerRow !== "number") {
    console.warn("[AI] Rule invalid: missing or invalid header");
    return false;
  }

  // Check that required fields are mapped
  const targetFields = mappings.map((m: any) => m.targetField).filter(Boolean);
  const hasSkuCode = targetFields.includes("SKU物品编码");
  const hasSkuName = targetFields.includes("SKU物品名称");
  const hasQty = targetFields.includes("SKU发货数量");

  if (!hasSkuCode || !hasSkuName || !hasQty) {
    console.warn(`[AI] Rule invalid: missing required fields (code=${hasSkuCode}, name=${hasSkuName}, qty=${hasQty})`);
    return false;
  }

  // Check sourceField is not empty for most mappings
  const emptySources = mappings.filter((m: any) => !m.sourceField || !m.sourceField.trim()).length;
  if (emptySources > mappings.length / 2) {
    console.warn(`[AI] Rule invalid: ${emptySources}/${mappings.length} mappings have empty sourceField`);
    return false;
  }

  return true;
}

// ===== 合并 AI 结果与本地兜底结果 =====
// AI 可能遗漏某些字段，用 localResult 补充
function mergeWithFallback(aiResult: any, localResult: Partial<ParseRule>): Partial<ParseRule> {
  const merged: Partial<ParseRule> = { ...localResult };

  // Use AI header if valid
  if (aiResult.header && typeof aiResult.header.headerRow === "number" && aiResult.header.headerRow >= 0) {
    merged.header = aiResult.header;
  }

  // Merge columnMappings: prefer AI's, fill missing with local's
  const aiMappings = (aiResult.columnMappings || []).map((m: any) => ({
    sourceField: m.sourceField || "",
    targetField: m.targetField || "",
    isRequired: m.isRequired || false,
    transform: m.transform || undefined,
    isStatic: m.isStatic || false,
    defaultValue: m.defaultValue || undefined,
    aiConfidence: m.aiConfidence || 0.7,
  }));

  const localMappings = localResult.columnMappings || [];
  const mergedMappings = [...aiMappings];

  // Add local mappings for targets that AI missed
  const aiTargets = new Set(aiMappings.map((m: any) => m.targetField));
  for (const lm of localMappings) {
    if (!aiTargets.has(lm.targetField)) {
      mergedMappings.push(lm);
    }
  }

  merged.columnMappings = mergedMappings;

  // Use AI advanced configs if present
  if (aiResult.footerExtraction?.enabled) merged.footerExtraction = aiResult.footerExtraction;
  if (aiResult.aggregation?.enabled) merged.aggregation = aiResult.aggregation;
  if (aiResult.matrixTranspose?.enabled) merged.matrixTranspose = aiResult.matrixTranspose;
  if (aiResult.multiSheet?.enabled) merged.multiSheet = aiResult.multiSheet;
  if (aiResult.cardBoundary?.enabled) merged.cardBoundary = aiResult.cardBoundary;
  if (aiResult.pdfConfig) merged.pdfConfig = aiResult.pdfConfig;
  if (aiResult.textParse?.enabled) merged.textParse = aiResult.textParse;

  console.log(`[AI] Merged rule: ${mergedMappings.length} mappings, headerRow=${merged.header?.headerRow}`);
  return merged;
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

  const lines = fileContent.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);

  // ---- 按文件类型分支 ----

  if (fileType === "pdf") {
    // PDF 分析：扫描文本内容找表头行和列名，和 Excel 一样做映射
    // 不再用硬编码空 sourceField，否则 parseSheet 永远匹配不到列
    let bestHeaderRow = 0;
    let bestScore = 0;
    let headerColumns: string[] = [];

    for (let i = 0; i < Math.min(lines.length, 30); i++) {
      const line = lines[i].replace(/^行\d+:\s*/, "");
      // PDF 表头行通常用 | 或多个空格分隔
      const cols = line.includes("|")
        ? line.split(/\s*\|\s*/).map((c) => c.trim()).filter((c) => c.length > 0)
        : line.split(/\s{2,}/).map((c) => c.trim()).filter((c) => c.length > 0);

      if (cols.length < 2) continue;

      let score = 0;
      const headerKeywords = ["编码", "名称", "数量", "规格", "物品", "序号", "收货", "电话", "地址", "门店",
                               "code", "name", "qty", "quantity", "spec", "remark", "item"];
      for (const col of cols) {
        const cl = col.toLowerCase().replace(/[*\s·・]/g, "");
        for (const kw of headerKeywords) {
          if (cl.includes(kw)) { score++; break; }
        }
      }
      if (cols.some(c => c.includes("编码"))) score += 2;
      if (cols.some(c => c.includes("名称"))) score += 2;
      if (cols.some(c => c.includes("数量"))) score += 2;

      if (score > bestScore) {
        bestScore = score;
        bestHeaderRow = i;
        headerColumns = cols;
      }
    }

    // 从最佳匹配行的 "行N:" 前缀提取实际行号
    const headerLineText = lines[bestHeaderRow] || "";
    const rowMatch = headerLineText.match(/^行(\d+):/);
    const actualHeaderRow = rowMatch ? parseInt(rowMatch[1], 10) : bestHeaderRow;

    console.log(`[localAnalyze-PDF] Best header at line ${bestHeaderRow}, row ${actualHeaderRow}, score=${bestScore}, cols=${headerColumns.length}`);

    rule.header = { skipRows: actualHeaderRow, headerRow: actualHeaderRow };

    // 用和 Excel 相同的映射逻辑
    if (headerColumns.length > 0 && bestScore > 0) {
      const mappings: any[] = [];
      const mappedTargets = new Set<string>();

      for (const col of headerColumns) {
        const cl = col.toLowerCase().replace(/[*\s·・]/g, "");
        let mapping: any = null;

        if (!mappedTargets.has("SKU物品编码") &&
            (cl.includes("物品编码") || cl.includes("sku编码") || cl.includes("产品编码") || cl === "编码" || cl.includes("序号") ||
             cl === "code" || cl.includes("itemcode") || cl.includes("item_code") || cl.includes("productcode"))) {
          mapping = { sourceField: col, targetField: "SKU物品编码", isRequired: true, aiConfidence: 0.9 };
        } else if (!mappedTargets.has("SKU物品名称") &&
            (cl.includes("物品名称") || cl.includes("sku名称") || cl.includes("产品名称") || cl.includes("品名") || cl === "名称" ||
             cl === "name" || cl.includes("itemname") || cl.includes("item_name") || cl.includes("productname"))) {
          mapping = { sourceField: col, targetField: "SKU物品名称", isRequired: true, aiConfidence: 0.9 };
        } else if (!mappedTargets.has("SKU发货数量") &&
            (cl.includes("数量") || cl.includes("件数") || cl === "qty" || cl === "quantity" || cl.includes("amount"))) {
          mapping = { sourceField: col, targetField: "SKU发货数量", isRequired: true, transform: "toNumber", aiConfidence: 0.9 };
        } else if (!mappedTargets.has("SKU规格型号") &&
            (cl.includes("规格") || cl.includes("型号") || cl === "spec" || cl.includes("specification"))) {
          mapping = { sourceField: col, targetField: "SKU规格型号", aiConfidence: 0.7 };
        } else if (!mappedTargets.has("外部编码") &&
            (cl.includes("单号") || cl.includes("配送号") || cl.includes("订单号") || cl.includes("运单号") ||
             cl.includes("单据号") || cl.includes("批次号") || cl.includes("orderno") || cl.includes("order_number"))) {
          mapping = { sourceField: col, targetField: "外部编码", aiConfidence: 0.8 };
        } else if (!mappedTargets.has("收件人姓名") &&
            (cl.includes("收货人") || cl.includes("收件人") || cl.includes("receiver") || cl.includes("contact"))) {
          mapping = { sourceField: col, targetField: "收件人姓名", aiConfidence: 0.7 };
        } else if (!mappedTargets.has("收件人电话") &&
            (cl.includes("电话") || cl.includes("手机") || cl.includes("phone") || cl.includes("tel"))) {
          mapping = { sourceField: col, targetField: "收件人电话", aiConfidence: 0.7 };
        } else if (!mappedTargets.has("收件人地址") &&
            (cl.includes("地址") || cl.includes("address"))) {
          mapping = { sourceField: col, targetField: "收件人地址", aiConfidence: 0.7 };
        } else if (!mappedTargets.has("收货门店") &&
            (cl.includes("门店") || cl.includes("店铺") || cl.includes("store") || cl.includes("shop"))) {
          mapping = { sourceField: col, targetField: "收货门店", aiConfidence: 0.7 };
        } else if (!mappedTargets.has("备注") &&
            (cl.includes("备注") || cl.includes("remark") || cl.includes("note") || cl.includes("comment"))) {
          mapping = { sourceField: col, targetField: "备注", aiConfidence: 0.6 };
        }

        if (mapping) {
          mappings.push(mapping);
          mappedTargets.add(mapping.targetField);
        }
      }

      rule.columnMappings = mappings;
      console.log(`[localAnalyze-PDF] Generated ${mappings.length} mappings:`, mappings.map(m => `${m.sourceField}→${m.targetField}`));
    } else {
      // 没找到表头，用空 sourceField + 同义词匹配兜底
      console.warn("[localAnalyze-PDF] No header found, using empty sourceField with synonym fallback");
      rule.columnMappings = [
        { sourceField: "", targetField: "SKU物品编码", aiConfidence: 0.7 },
        { sourceField: "", targetField: "SKU物品名称", aiConfidence: 0.7 },
        { sourceField: "", targetField: "SKU发货数量", isRequired: true, transform: "toNumber", aiConfidence: 0.7 },
        { sourceField: "规格型号", targetField: "SKU规格型号", aiConfidence: 0.6 },
      ];
    }

    // 检测是否需要多订单切分（PDF 中包含多个独立签收单）
    // 仅在明确有多个分隔符出现时才启用，避免误判
    const pageBreakCount = (fileContent.match(/PAGE BREAK/g) || []).length;
    const receiverKeywords = ["签收人", "收货人", "收件人"];
    // 检查分隔符出现次数（至少出现 2 次才认为是多订单）
    let separatorCount = 0;
    for (const kw of receiverKeywords) {
      const matches = fileContent.match(new RegExp(kw, "g"));
      separatorCount += matches ? matches.length : 0;
    }
    if (pageBreakCount > 0 && separatorCount >= 2) {
      rule.pdfConfig = {
        headerSkipLines: actualHeaderRow,
        tableHeaderPattern: detectTableHeader(lines),
        footerKeyword: "收货人",
        multiOrder: true,
        orderSeparator: "签收人|收货人|收件人",
      };
    }

    // 尾部收货信息提取
    rule.footerExtraction = {
      enabled: true,
      sections: [{
        name: "收货信息",
        startKeyword: "收货人",
        fields: [
          { keyword: "收货人", targetField: "收件人姓名", offset: 1 },
          { keyword: "收货电话", targetField: "收件人电话", offset: 1 },
          { keyword: "收货地址", targetField: "收件人地址", offset: 0 },
        ],
      }],
    };

    return rule;
  }

  if (fileType === "word") {
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
  // 检测表头行：找包含关键列名（编码/名称/数量）的行，用密度评分避免误匹配标题行
  let bestHeaderRow = 0;
  let bestScore = 0;

  for (let i = 0; i < Math.min(lines.length, 25); i++) {
    const line = lines[i];
    const cleanLine = line.replace(/^行\d+:\s*/, "").toLowerCase();

    // 标题行通常很短或只有1-2列，跳过
    const colCount = (cleanLine.match(/\|/g) || []).length + 1;
    if (colCount < 3) continue;

    // 评分：每命中一个关键词+1，有"编码"或"名称"额外+2
    let score = 0;
    const headerKeywords = ["编码", "名称", "数量", "规格", "单号", "配送", "收货", "电话", "地址", "门店"];
    for (const kw of headerKeywords) {
      if (cleanLine.includes(kw)) score++;
    }
    if (cleanLine.includes("编码")) score += 2;
    if (cleanLine.includes("名称")) score += 2;
    if (cleanLine.includes("数量")) score += 2;

    // 必须有"编码"和"名称"至少一个才认为是表头
    if (!cleanLine.includes("编码") && !cleanLine.includes("名称")) score = 0;

    if (score > bestScore) {
      bestScore = score;
      bestHeaderRow = i;
    }
  }

  // 从最佳匹配行的 "行N:" 前缀提取实际行号
  const headerLineText = lines[bestHeaderRow] || "";
  const rowMatch = headerLineText.match(/^行(\d+):/);
  const actualHeaderRow = rowMatch ? parseInt(rowMatch[1], 10) : bestHeaderRow;

  console.log(`[localAnalyze] Best header at text line ${bestHeaderRow}, actual Excel row ${actualHeaderRow}, score=${bestScore}`);
  rule.header = { skipRows: actualHeaderRow, headerRow: actualHeaderRow };

  // 分析表头列
  const headerLine = headerLineText.replace(/^行\d+:\s*/, "");
  const columns = headerLine.split(/\s*\|\s*/).map((c) => c.trim()).filter((c) => c.length > 0);

  console.log(`[localAnalyze] Extracted ${columns.length} columns:`, columns);

  if (columns.length === 0) {
    console.warn("[localAnalyze] Could not extract columns from header line:", headerLine);
  }

  // 自动映射列（使用剥离前缀后的纯净列名）
  const mappings: any[] = [];
  const mappedTargets = new Set<string>();

  columns.forEach((col) => {
    const cl = col.toLowerCase().replace(/[*\s·・]/g, "");
    let mapping: any = null;

    // 优先级1: SKU物品编码（最核心字段，必须优先匹配）
    // "编码"单独出现时优先认为是SKU编码，而非单号
    if (!mappedTargets.has("SKU物品编码") &&
        (cl === "编码" || cl.includes("物品编码") || cl.includes("sku编码") || cl.includes("产品编码") || cl.includes("货号") || cl.includes("物料编码") || cl.includes("商品编码"))) {
      mapping = { sourceField: col, targetField: "SKU物品编码", isRequired: true, aiConfidence: 0.9 };
    }
    // 优先级2: SKU物品名称
    else if (!mappedTargets.has("SKU物品名称") &&
             (cl === "名称" || cl.includes("物品名称") || cl.includes("sku名称") || cl.includes("产品名称") || cl.includes("品名") || cl.includes("商品名称"))) {
      mapping = { sourceField: col, targetField: "SKU物品名称", isRequired: true, aiConfidence: 0.9 };
    }
    // 优先级3: SKU发货数量
    else if (!mappedTargets.has("SKU发货数量") &&
             (cl.includes("数量") || cl.includes("发货") || cl.includes("出库") || cl.includes("件数"))) {
      mapping = { sourceField: col, targetField: "SKU发货数量", isRequired: true, transform: "toNumber", aiConfidence: 0.9 };
    }
    // 优先级4: SKU规格型号
    else if (!mappedTargets.has("SKU规格型号") &&
             (cl.includes("规格") || cl.includes("型号"))) {
      mapping = { sourceField: col, targetField: "SKU规格型号", aiConfidence: 0.7 };
    }
    // 优先级5: 外部编码（必须是明确的单号类词，"编码"单独不算）
    // 配送单号、订单号、运单号、出库单号、单据号、批次号 才是单号
    // "编码"已归到SKU物品编码，这里排除
    else if (!mappedTargets.has("外部编码") &&
             (cl.includes("单号") || cl.includes("配送号") || cl.includes("订单号") ||
              cl.includes("运单号") || cl.includes("出库单号") || cl.includes("单据号") ||
              cl.includes("批次号") || cl.includes("orderno") || cl.includes("order_number"))) {
      mapping = { sourceField: col, targetField: "外部编码", aiConfidence: 0.8 };
    }
    // 优先级6: 收货门店
    else if (!mappedTargets.has("收货门店") &&
             (cl.includes("门店") || cl.includes("店铺") || cl.includes("仓库") || cl.includes("机构"))) {
      mapping = { sourceField: col, targetField: "收货门店", aiConfidence: 0.7 };
    }
    // 优先级7: 收件人姓名
    else if (!mappedTargets.has("收件人姓名") &&
             (cl.includes("收货人") || cl.includes("收件人") || cl.includes("联系人"))) {
      mapping = { sourceField: col, targetField: "收件人姓名", aiConfidence: 0.7 };
    }
    // 优先级8: 收件人电话
    else if (!mappedTargets.has("收件人电话") &&
             (cl.includes("电话") || cl.includes("手机"))) {
      mapping = { sourceField: col, targetField: "收件人电话", aiConfidence: 0.7 };
    }
    // 优先级9: 收件人地址
    else if (!mappedTargets.has("收件人地址") &&
             (cl.includes("地址"))) {
      mapping = { sourceField: col, targetField: "收件人地址", aiConfidence: 0.7 };
    }
    // 优先级10: 备注
    else if (!mappedTargets.has("备注") && cl.includes("备注")) {
      mapping = { sourceField: col, targetField: "备注", aiConfidence: 0.6 };
    }

    if (mapping) {
      mappings.push(mapping);
      mappedTargets.add(mapping.targetField);
    }
  });

  // 如果没有映射到外部编码，但有"单号"相关列，用第一个匹配的列
  if (!mappedTargets.has("外部编码")) {
    for (const col of columns) {
      const cl = col.toLowerCase().replace(/[*\s·・]/g, "");
      if (cl.includes("单号") || cl.includes("配送号") || cl.includes("订单号") ||
          cl.includes("运单号") || cl.includes("单据号") || cl.includes("批次号")) {
        mappings.push({ sourceField: col, targetField: "外部编码", aiConfidence: 0.7 });
        mappedTargets.add("外部编码");
        break;
      }
    }
  }

  // 检测是否需要跨行聚合（看是否有"配送单号"或"单号"列）
  const hasGroupBy = columns.some((c) => {
    const cl = c.toLowerCase().replace(/[*\s·・]/g, "");
    return cl.includes("单号") || cl.includes("配送号") || cl.includes("订单号") || cl.includes("运单号");
  });
  if (hasGroupBy) {
    rule.aggregation = {
      enabled: true,
      groupByField: "外部编码",
      sharedFields: ["收件人姓名", "收件人电话", "收件人地址", "收货门店"],
    };
    // 添加收货人相关映射（如果尚未添加）
    columns.forEach((col) => {
      const cl = col.toLowerCase().replace(/[*\s·・]/g, "");
      if (mappedTargets.has("收件人姓名") && mappedTargets.has("收件人电话")) return;
      if (cl.includes("收货人") || cl.includes("收件人")) {
        if (!mappedTargets.has("收件人姓名")) {
          mappings.push({ sourceField: col, targetField: "收件人姓名", aiConfidence: 0.8 });
          mappedTargets.add("收件人姓名");
        }
      } else if (cl.includes("电话") || cl.includes("手机")) {
        if (!mappedTargets.has("收件人电话")) {
          mappings.push({ sourceField: col, targetField: "收件人电话", aiConfidence: 0.8 });
          mappedTargets.add("收件人电话");
        }
      } else if (cl.includes("地址")) {
        if (!mappedTargets.has("收件人地址")) {
          mappings.push({ sourceField: col, targetField: "收件人地址", aiConfidence: 0.8 });
          mappedTargets.add("收件人地址");
        }
      }
    });
  }

  // 检测是否有尾部收货信息（在数据区之后）
  const dataEndIdx = lines.findIndex((l, i) =>
    i > bestHeaderRow + 2 &&
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

  // 检测是否为多Sheet
  const sheetCount = (fileContent.match(/--- Sheet:/g) || []).length;
  if (sheetCount >= 2) {
    rule.multiSheet = { enabled: true, extractStoreName: true };
  }

  rule.columnMappings = mappings;

  // 安全检查：如果没有映射到任何列，记录警告
  if (mappings.length === 0) {
    console.warn("[localAnalyze] WARNING: Zero column mappings generated!");
    console.warn("[localAnalyze] Header line:", headerLine);
    console.warn("[localAnalyze] Columns:", columns);
  } else {
    console.log(`[localAnalyze] Generated ${mappings.length} mappings:`, mappings.map((m) => `${m.sourceField}→${m.targetField}`));
  }

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

// ===== 构建 AI 审核提示（极简版，减少 reasoning 开销）=====
function buildReviewPrompt(
  fileContent: string,
  fileName: string,
  fileType: string,
  localResult: Partial<ParseRule>
): string {
  // 只取文件前 600 字符（表头 + 少量数据行就够了）
  const preview = fileContent.substring(0, 600);
  
  // 把本地分析结果序列化为紧凑 JSON
  const localJson = JSON.stringify(localResult, null, 0);
  
  return `文件:${fileName}(${fileType})
${preview}

本地规则:${localJson}

修正此规则。仅输出JSON。`;
}
