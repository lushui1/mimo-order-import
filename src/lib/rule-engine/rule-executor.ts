// ===== 规则执行器 =====
// 根据 ParseRule 配置，将 RawFile 解析为结构化运单数据
// 支持：头部跳过 → 列映射 → 尾部提取 → 跨行聚合 → 矩阵转置 → 卡片模式 → 多Sheet → 复合单元格拆分

import type { ParseRule, ParsedOrder } from "./types";
import type { RawFile, RawSheet } from "./file-parser";

// 常见字段的同义词映射（用于增强模糊匹配）
const FIELD_SYNONYMS: Record<string, string[]> = {
  "SKU物品编码": ["编码", "物品编码", "SKU编码", "产品编码", "货号", "物料编码", "商品编码"],
  "SKU物品名称": ["名称", "物品名称", "SKU名称", "产品名称", "品名", "商品名称"],
  "SKU发货数量": ["数量", "发货数量", "出库数量", "需求数量", "件数"],
  "SKU规格型号": ["规格", "规格型号", "型号", "尺寸", "参数"],
  "收件人姓名": ["收货人", "收件人", "联系人", "接收人", "客户"],
  "收件人电话": ["电话", "手机", "联系电话", "手机号码", "联系方式"],
  "收件人地址": ["地址", "收货地址", "配送地址", "邮寄地址"],
  "收货门店": ["门店", "店铺", "仓库", "机构", "网点", "站点"],
  "外部编码": ["配送单号", "外部编码", "订单号", "单号", "运单号", "出库单号", "批次号"],
  "备注": ["备注", "说明", "备注信息", "摘要"],
};

// 规范化字符串：去掉 *、空格、特殊字符，转小写
function normalizeStr(s: string | null | undefined): string {
  if (!s) return "";
  return String(s).replace(/[*\s·・`~!@#$%^&*()_+=\[\]{};:'",.<>?/\\|\-]/g, "").toLowerCase();
}

// ----- 自动检测表头行（基于关键词密度评分）-----
function autoDetectHeaderRow(sheet: RawSheet): number {
  const keywords = ["编码", "名称", "数量", "规格", "门店", "地址", "SKU", "物品", "收货",
                     "单号", "电话", "配送", "联系人", "备注", "型号"];
  let bestRow = 0;
  let bestScore = -1;

  for (let i = 0; i < Math.min(20, sheet.rows.length); i++) {
    const row = sheet.rows[i];
    if (!row) continue;
    // 计算关键词命中密度：每个命中+1，行长度(列数)归一化
    let score = 0;
    let nonEmptyCols = 0;
    for (let c = 0; c < row.length; c++) {
      const val = row[c];
      if (val === null || val === "") continue;
      nonEmptyCols++;
      const strVal = String(val).toLowerCase();
      for (const kw of keywords) {
        if (strVal.includes(kw.toLowerCase())) {
          score++;
          break; // 每列最多计数一次
        }
      }
    }
    // 密度分 = 命中列数 / 非空列数（避免全是空列的行得分高）
    const density = nonEmptyCols > 0 ? score / Math.max(1, nonEmptyCols) : 0;
    // 额外加分：含有"编码"或"名称"关键词 +2
    const rowStr = row.map(c => (c === null ? "" : String(c))).join("").toLowerCase();
    if (rowStr.includes("编码") || rowStr.includes("名称")) score += 2;

    if (density > bestScore || (density === bestScore && score > 0)) {
      bestScore = density;
      bestRow = i;
    }
  }

  // 如果没找到足够好的表头（密度 < 0.15），返回0
  if (bestScore < 0.15 && bestRow > 0) {
    console.log(`[autoDetectHeaderRow] Low confidence (score=${bestScore.toFixed(2)}), returning row ${bestRow} anyway`);
  }
  console.log(`[autoDetectHeaderRow] Best header at row ${bestRow} (density=${bestScore?.toFixed(2)})`);
  return bestRow;
}

// 在 headerRow 附近 ±range 行内扫描最佳匹配
function scanHeaderRows(
  sheet: RawSheet,
  centerRow: number,
  columnMappings: ParseRule["columnMappings"],
  range: number = 3
): { row: number; fieldMap: Map<string, { colIndex: number; mapping: ParseRule["columnMappings"][0] }>; matched: number } {
  const startRow = Math.max(0, centerRow - range);
  const endRow = Math.min(sheet.rows.length - 1, centerRow + range);
  let bestResult = { row: centerRow, fieldMap: new Map() as Map<string, any>, matched: 0 };

  for (let r = startRow; r <= endRow; r++) {
    const fm = new Map<string, { colIndex: number; mapping: ParseRule["columnMappings"][0] }>();
    const matched = buildFieldMap(sheet, r, columnMappings, fm);
    if (matched > bestResult.matched) {
      bestResult = { row: r, fieldMap: fm, matched };
    }
    if (matched === columnMappings.filter(m => !m.isStatic).length) break; // 全部匹配，不再继续
  }

  return bestResult;
}

// ----- 从规则获取源列索引（精确匹配 + 规范化匹配 + 模糊兜底 + 同义词匹配）-----
function findColumnIndex(sheet: RawSheet, headerRow: number, fieldName: string, targetField?: string): number {
  const row = sheet.rows[headerRow];
  if (!row) return -1;

  const normalizedField = normalizeStr(fieldName);

  // Step 1: Exact match (trimmed)
  for (let c = 0; c < row.length; c++) {
    if (row[c] !== null && String(row[c]).trim() === fieldName) return c;
  }

  // Step 1.5: Normalized match (strip special chars, case-insensitive)
  // 处理 AI 返回 "物品编码*" vs 实际列头 "物品编码" 或 "物品 编码" 等差异
  if (normalizedField.length >= 2) {
    for (let c = 0; c < row.length; c++) {
      const val = row[c];
      if (val !== null) {
        const cellNorm = normalizeStr(String(val));
        if (cellNorm === normalizedField) {
          console.log(`[findColumnIndex] Normalized match: "${fieldName}" ↔ "${String(val).trim()}" at col ${c}`);
          return c;
        }
      }
    }
  }

  // Step 2: Fuzzy match (contains)
  if (fieldName.length >= 2) {
    for (let c = 0; c < row.length; c++) {
      if (row[c] !== null && String(row[c]).trim().includes(fieldName)) return c;
    }
  }

  // Step 3: Reverse fuzzy (header contains fieldName keyword)
  // 增加长度限制：列头通常较短（<=30字符），避免把包含关键词的长文本值误判为列头
  if (normalizedField.length >= 2) {
    for (let c = 0; c < row.length; c++) {
      const val = row[c];
      if (val === null) continue;
      const strVal = String(val).trim();
      if (strVal.length > 30) continue; // 跳过太长的单元格（不是列头）
      const cell = normalizeStr(strVal);
      if (cell && (cell.includes(normalizedField) || normalizedField.includes(cell))) return c;
    }
  }

  // Step 4: Synonym match (using targetField to lookup synonyms)
  // 同样增加长度限制，避免误判
  if (targetField) {
    const synonyms = FIELD_SYNONYMS[targetField] || [];
    for (const syn of synonyms) {
      const normalizedSyn = normalizeStr(syn);
      for (let c = 0; c < row.length; c++) {
        const val2 = row[c];
        if (val2 === null) continue;
        const strVal2 = String(val2).trim();
        if (strVal2.length > 30) continue;
        const cell2 = normalizeStr(strVal2);
        if (cell2 && (cell2.includes(normalizedSyn) || normalizedSyn.includes(cell2))) {
          console.log(`[findColumnIndex] Synonym match: "${syn}" → column ${c} ("${row[c]}")`);
          return c;
        }
      }
    }
  }

  return -1;
}

function findColumnIndexByNumber(sheet: RawSheet, colIndex: number): boolean {
  return colIndex >= 0 && colIndex <= (sheet.maxCol || 0);
}

// ----- 解析单个 Sheet -----
function parseSheet(rule: ParseRule, sheet: RawSheet, _sheetName: string): ParsedOrder[] {
  let { header, columnMappings } = rule;
  let headerRow = header.headerRow;
  const orders: ParsedOrder[] = [];

  // Build field → column index mapping
  let fieldMap = new Map<string, { colIndex: number; mapping: typeof columnMappings[0] }>();

  console.log(`[parseSheet] Sheet="${_sheetName}" ruleHeaderRow=${headerRow} totalRows=${sheet.rows.length}`);

  // ==== 多层次表头检测：扫描规则指定的行 ±3 → 自动检测行 ±3 → 全表头候选行 ====
  let matchedCols = 0;

  // Level 1: 规则指定的 headerRow ±3 范围内扫描
  if (columnMappings.length > 0) {
    const scanResult = scanHeaderRows(sheet, headerRow, columnMappings, 3);
    fieldMap = scanResult.fieldMap;
    matchedCols = scanResult.matched;
    if (scanResult.row !== headerRow && matchedCols > 0) {
      headerRow = scanResult.row;
      console.log(`[parseSheet] Level 1 scan: shifted headerRow ${header.headerRow}→${headerRow}, matched ${matchedCols}`);
    }
  }

  // Level 2: 自动检测表头行（密度评分）→ 在其 ±3 范围内扫描
  if (matchedCols === 0 && columnMappings.length > 0) {
    console.warn(`[parseSheet] Level 1 failed (${matchedCols} cols at headerRow=${headerRow}), trying auto-detect...`);
    const detected = autoDetectHeaderRow(sheet);
    if (detected !== headerRow && detected < sheet.rows.length) {
      const scanResult = scanHeaderRows(sheet, detected, columnMappings, 3);
      if (scanResult.matched > 0) {
        fieldMap = scanResult.fieldMap;
        matchedCols = scanResult.matched;
        headerRow = scanResult.row;
        console.log(`[parseSheet] Level 2 auto-detect: headerRow=${headerRow}, matched ${matchedCols}`);
      }
    }
  }

  // Level 3: 全表头候选行遍历（前 15 行中匹配数最高的）
  if (matchedCols === 0 && columnMappings.length > 0) {
    console.warn(`[parseSheet] Level 2 failed, scanning all candidate header rows...`);
    let bestAll = { row: 0, fieldMap: fieldMap, matched: 0 };
    for (let r = 0; r < Math.min(15, sheet.rows.length); r++) {
      const fm = new Map<string, { colIndex: number; mapping: typeof columnMappings[0] }>();
      const m = buildFieldMap(sheet, r, columnMappings, fm);
      if (m > bestAll.matched) {
        bestAll = { row: r, fieldMap: fm, matched: m };
        if (m === columnMappings.filter(mc => !mc.isStatic).length) break;
      }
    }
    if (bestAll.matched > 0) {
      fieldMap = bestAll.fieldMap;
      matchedCols = bestAll.matched;
      headerRow = bestAll.row;
      console.log(`[parseSheet] Level 3 full scan: headerRow=${headerRow}, matched ${matchedCols}`);
    }
  }

  if (matchedCols === 0 && columnMappings.length > 0) {
    console.warn(`[parseSheet] CRITICAL: ZERO columns matched after all 3 levels!`);
    console.warn(`[parseSheet] Rule expects:`, columnMappings.map(m => `${m.sourceField}→${m.targetField}`));
    for (let r = 0; r < Math.min(10, sheet.rows.length); r++) {
      const hdrRow = sheet.rows[r];
      console.warn(`[parseSheet] Row ${r}:`, hdrRow?.slice(0, 15).map(c => c === null ? "NULL" : `"${String(c).substring(0, 20)}"`));
    }
  } else if (columnMappings.length > 0) {
    console.log(`[parseSheet] Final: headerRow=${headerRow}, matched ${matchedCols}/${columnMappings.filter(m => !m.isStatic).length} columns`);
  }

  // Process data rows
  for (let r = headerRow + 1; r < sheet.rows.length; r++) {
    const row = sheet.rows[r];

    // Skip empty rows
    if (!row || row.every((c) => c === null || c === "")) continue;

    // Skip 合计/总计/汇总/小计行 — 扫描整行所有单元格
    if (isSummaryRow(row)) continue;

    const order: ParsedOrder = {
      rowIndex: r,
      SKU物品编码: "",
      SKU物品名称: "",
      SKU发货数量: 0,
      _source: _sheetName,
    };

    // Apply static fields
    for (const mapping of columnMappings) {
      if (mapping.isStatic && mapping.defaultValue) {
        (order as any)[mapping.targetField] = mapping.defaultValue;
      }
    }

    // Apply column mappings
    for (const [targetField, { colIndex, mapping }] of fieldMap) {
      if (colIndex < 0 || colIndex >= row.length) {
        if (mapping.defaultValue) {
          (order as any)[targetField] = mapping.defaultValue;
        }
        continue;
      }
      let val = row[colIndex];
      if (val === null || val === "") {
        if (mapping.defaultValue) {
          (order as any)[targetField] = mapping.defaultValue;
        }
        continue;
      }

      let strVal = String(val).trim();

      // Apply transform
      if (mapping.transform) {
        const transforms = mapping.transform.split("|");
        for (const t of transforms) {
          switch (t.trim()) {
            case "trim":
              strVal = strVal.trim();
              break;
            case "toNumber": {
              const num = parseFloat(strVal.replace(/[^\d.-]/g, ""));
              if (!isNaN(num)) {
                (order as any)[targetField] = num;
              }
              continue;
            }
          }
        }
      }

      if (targetField === "SKU发货数量") {
        const num = parseFloat(strVal.replace(/[^\d.-]/g, ""));
        order.SKU发货数量 = isNaN(num) ? 0 : num;
      } else {
        (order as any)[targetField] = strVal;
      }
    }

    // Skip if no SKU data
    if (!order.SKU物品编码 && !order.SKU物品名称?.trim()) continue;

    orders.push(order);
  }

  return orders;
}

// Helper: build field map and return matched column count
function buildFieldMap(
  sheet: RawSheet,
  headerRow: number,
  columnMappings: ParseRule["columnMappings"],
  fieldMap: Map<string, { colIndex: number; mapping: ParseRule["columnMappings"][0] }>
): number {
  const hdrRow = sheet.rows[headerRow];
  if (hdrRow) {
    console.log(`[buildFieldMap] Headers at row ${headerRow}:`, hdrRow.slice(0, 12).map(c => c === null ? "NULL" : `"${String(c).trim()}"`));
  }

  let matched = 0;
  for (const mapping of columnMappings) {
    if (mapping.isStatic) continue;

    let colIndex = -1;

    // Step A: SourceField 匹配（4级匹配：精确→模糊→反向→同义词）
    if (mapping.sourceField && mapping.sourceField.trim()) {
      colIndex = findColumnIndex(sheet, headerRow, mapping.sourceField, mapping.targetField);
      console.log(`[buildFieldMap] sourceField="${mapping.sourceField}" → "${mapping.targetField}" = col ${colIndex}`);
    }

    // Step B: SourceField 为空或匹配失败 → 直接用 targetField 的同义词搜索列头
    if (colIndex < 0) {
      console.log(`[buildFieldMap] sourceField miss, falling back to targetField synonyms for "${mapping.targetField}"`);
      colIndex = findColumnByTargetField(sheet, headerRow, mapping.targetField);
      if (colIndex >= 0) {
        console.log(`[buildFieldMap] targetField synonym match: "${mapping.targetField}" → col ${colIndex} ("${hdrRow?.[colIndex]}")`);
      }
    }

    // Step C: sourceField 是数字 → 按列索引
    if (colIndex < 0) {
      const num = parseInt(mapping.sourceField || "");
      if (!isNaN(num)) {
        colIndex = num;
        console.log(`[buildFieldMap] numeric sourceField "${mapping.sourceField}" → col ${colIndex}`);
      }
    }

    if (colIndex >= 0) matched++;
    fieldMap.set(mapping.targetField, { colIndex, mapping });
  }
  return matched;
}

// 直接用 targetField 和其同义词搜索列头（当 sourceField 不匹配时兜底）
function findColumnByTargetField(sheet: RawSheet, headerRow: number, targetField: string): number {
  const row = sheet.rows[headerRow];
  if (!row) return -1;

  const synonyms = FIELD_SYNONYMS[targetField] || [];

  // 先尝试用 targetField 本身的规范化名称
  const normalizedTarget = normalizeStr(targetField);
  const searchTerms = [targetField, normalizedTarget, ...synonyms];

  for (const term of searchTerms) {
    if (!term) continue;
    const nTerm = normalizeStr(term);
    if (!nTerm || nTerm.length < 1) continue;

    for (let c = 0; c < row.length; c++) {
      const val = row[c];
      if (val === null) continue;
      const cellNormalized = normalizeStr(String(val));
      if (!cellNormalized) continue;

      // 精确匹配 / 包含匹配 / 反向包含
      if (cellNormalized === nTerm ||
          cellNormalized.includes(nTerm) ||
          nTerm.includes(cellNormalized)) {
        return c;
      }
    }
  }

  return -1;
}

// 检测一行是否为汇总/合计/统计行（非数据行）
function isSummaryRow(row: (string | number | null)[]): boolean {
  if (!row || row.length === 0) return false;

  // 汇总关键词：出现在任意单元格即视为汇总行
  const summaryKeywords = [
    "合计", "总计", "共计", "小计", "累计", "汇总",
    "总调拨数量", "总数量", "总金额",
  ];

  // 汇总行模式：如 "3 个门店 | 9 种物品 | 总调拨数量：44 件/包"
  const summaryPatterns = [
    /\d+\s*个\s*(门店|仓库|站点|店铺)/,
    /\d+\s*种\s*(物品|商品|SKU)/,
    /总(调拨|发货|出库|入库)数量[：:]/,
    /合计[：:]\s*\d+/,
    /总计[：:]\s*\d+/,
  ];

  for (let c = 0; c < row.length; c++) {
    const val = row[c];
    if (val === null || val === "") continue;
    const strVal = String(val).trim();

    // 检查关键词
    for (const kw of summaryKeywords) {
      if (strVal.includes(kw)) {
        console.log(`[isSummaryRow] Skipping summary row (keyword "${kw}" in col ${c}): "${strVal.substring(0, 60)}"`);
        return true;
      }
    }

    // 检查正则模式
    for (const pattern of summaryPatterns) {
      if (pattern.test(strVal)) {
        console.log(`[isSummaryRow] Skipping summary row (pattern match in col ${c}): "${strVal.substring(0, 60)}"`);
        return true;
      }
    }
  }

  return false;
}

// ----- 尾部信息提取 -----
function applyFooterExtraction(rule: ParseRule, sheet: RawSheet, orders: ParsedOrder[]): void {
  if (!rule.footerExtraction?.enabled || !rule.footerExtraction.sections.length) return;

  for (const section of rule.footerExtraction.sections) {
    // Find the start row
    let startRow = -1;
    for (let r = 0; r < sheet.rows.length; r++) {
      const row = sheet.rows[r];
      if (row && row[0] !== null && String(row[0]).includes(section.startKeyword)) {
        startRow = r;
        break;
      }
    }
    if (startRow < 0) continue;

    const row = sheet.rows[startRow];
    for (const field of section.fields) {
      const val = row[field.offset] ?? "";
      if (val !== null && val !== "") {
        for (const order of orders) {
          (order as any)[field.targetField] = String(val).trim();
        }
      }
    }
  }
}

// ----- 跨行聚合（按外部编码分组，SKU 去重合并）-----
function applyAggregation(rule: ParseRule, orders: ParsedOrder[]): ParsedOrder[] {
  if (!rule.aggregation?.enabled) return orders;

  // 始终按 "外部编码" 分组（这是 targetField，不是 sourceField）
  const groupField = "外部编码";
  const sharedFields = rule.aggregation.sharedFields;

  // Step 1: 按外部编码分组（O(n) Map 查找）
  const groups = new Map<string, ParsedOrder[]>();
  for (const order of orders) {
    const key = String((order as any)[groupField] || "").trim();
    const groupKey = key || `__ungrouped_${order.rowIndex}`;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey)!.push(order);
  }

  // Step 2: 对每个分组做 SKU 去重合并 + 收货信息共享
  const result: ParsedOrder[] = [];
  for (const [groupKey, group] of groups) {
    if (group.length === 0) continue;

    // 收集该组的收货信息（取第一个非空值）
    const sharedInfo: Record<string, string> = {};
    for (const field of sharedFields) {
      for (const order of group) {
        const val = (order as any)[field];
        if (val && String(val).trim()) {
          sharedInfo[field] = String(val).trim();
          break;
        }
      }
    }

    // SKU 去重：相同 SKU物品编码 合并（数量求和）
    const skuMap = new Map<string, ParsedOrder>();
    for (const order of group) {
      const skuKey = String(order.SKU物品编码 || "").trim() || `__no_code_${order.rowIndex}`;
      if (skuMap.has(skuKey)) {
        // 合并：数量求和
        const existing = skuMap.get(skuKey)!;
        existing.SKU发货数量 = (existing.SKU发货数量 || 0) + (order.SKU发货数量 || 0);
        // 补充缺失的名称/规格
        if (!existing.SKU物品名称 && order.SKU物品名称) existing.SKU物品名称 = order.SKU物品名称;
        if (!existing.SKU规格型号 && order.SKU规格型号) existing.SKU规格型号 = order.SKU规格型号;
        if (!existing.备注 && order.备注) existing.备注 = order.备注;
      } else {
        skuMap.set(skuKey, { ...order });
      }
    }

    // 填充共享收货信息 + 标记分组
    let orderIdx = 0;
    for (const [, order] of skuMap) {
      for (const field of sharedFields) {
        if (sharedInfo[field] && !(order as any)[field]) {
          (order as any)[field] = sharedInfo[field];
        } else if (sharedInfo[field]) {
          // 强制统一收货信息（同组共享）
          (order as any)[field] = sharedInfo[field];
        }
      }
      // 添加分组标记，供 UI 分组展示
      (order as any)._groupKey = groupKey;
      (order as any)._groupSize = skuMap.size;
      (order as any)._groupIndex = orderIdx++;
      result.push(order);
    }
  }

  console.log(`[applyAggregation] ${orders.length} rows → ${result.length} rows in ${groups.size} groups`);
  return result;
}

// ----- 矩阵转置 -----
function applyMatrixTranspose(rule: ParseRule, orders: ParsedOrder[]): ParsedOrder[] {
  if (!rule.matrixTranspose?.enabled) return orders;

  const { dimensionColumns, dimensionField, quantityField } = rule.matrixTranspose;
  const result: ParsedOrder[] = [];

  for (const order of orders) {
    let hasTransposed = false;
    for (const dimCol of dimensionColumns) {
      const storeName = String(Object.values(order)[dimCol] || "").trim();
      // Skip if the dimension column doesn't exist or is empty
      if (!storeName) continue;
      
      // Find the value in the corresponding column
      // dimensionColumns are the store name columns from the header
      const newOrder: ParsedOrder = { ...order };
      (newOrder as any)[dimensionField] = storeName;
      (newOrder as any)[quantityField] = 1; // Default 1 if present
      result.push(newOrder);
      hasTransposed = true;
    }
    if (!hasTransposed) {
      result.push(order);
    }
  }

  return result;
}

// ----- 卡片模式 -----
function applyCardBoundary(rule: ParseRule, sheet: RawSheet): ParsedOrder[] {
  if (!rule.cardBoundary?.enabled) return [];
  
  const { startPattern, dataStartOffset } = rule.cardBoundary;
  const cards: { startRow: number; headerRows: number }[] = [];
  const regex = new RegExp(startPattern);

  // Find card boundaries
  for (let r = 0; r < sheet.rows.length; r++) {
    const row = sheet.rows[r];
    if (row && row[0] !== null && regex.test(String(row[0]))) {
      cards.push({ startRow: r, headerRows: 0 });
    }
  }

  const allOrders: ParsedOrder[] = [];

  for (const card of cards) {
    // Extract store info from card header
    const storeRow = card.startRow + 1;
    const addressRow = card.startRow + 2;
    
    let 收货门店 = "";
    let 收件人姓名 = "";
    let 收件人电话 = "";
    let 收件人地址 = "";

    if (storeRow < sheet.rows.length) {
      const sr = sheet.rows[storeRow];
      if (sr) {
        // 调入门店: 值(offset1), 收货人: 值(offset3), 电话: 值(offset5)
        const rowVals = sr.map((v) => (v === null ? "" : String(v).trim()));
        for (let i = 0; i < rowVals.length; i++) {
          if (rowVals[i] === "收货人" && i + 1 < rowVals.length) 收件人姓名 = rowVals[i + 1];
          if (rowVals[i] === "电话" && i + 1 < rowVals.length) 收件人电话 = rowVals[i + 1];
        }
      }
    }
    if (addressRow < sheet.rows.length) {
      const ar = sheet.rows[addressRow];
      if (ar) {
        const rowVals = ar.map((v) => (v === null ? "" : String(v).trim()));
        for (let i = 0; i < rowVals.length; i++) {
          if (rowVals[i] === "收货地址" && i + 1 < rowVals.length) 收件人地址 = rowVals[i + 1];
        }
      }
    }

    // Data table header
    const dataHeaderRow = card.startRow + dataStartOffset;
    const dataStart = dataHeaderRow + 1;

    // Build field map from data table header
    const headerRow = sheet.rows[dataHeaderRow];
    if (!headerRow) continue;

    const fieldIdx: Record<string, number> = {};
    const hdrVals = headerRow.map((v) => (v === null ? "" : String(v).trim()));
    for (let i = 0; i < hdrVals.length; i++) {
      if (hdrVals[i].includes("编码")) fieldIdx["编码"] = i;
      else if (hdrVals[i] === "物品名称" || hdrVals[i].includes("名称")) fieldIdx["名称"] = i;
      else if (hdrVals[i] === "规格" || hdrVals[i].includes("规格")) fieldIdx["规格"] = i;
      else if (hdrVals[i] === "数量" || hdrVals[i].includes("数量")) fieldIdx["数量"] = i;
    }

    // Read data rows until next card or end
    for (let r = dataStart; r < sheet.rows.length; r++) {
      const row = sheet.rows[r];
      if (!row) break;
      if (row[0] && String(row[0]).startsWith("▶")) break;
      
      const vals = row.map((v) => (v === null ? "" : String(v).trim()));
      if (vals.every((v) => !v)) continue;
      if (isSummaryRow(row)) continue;

      const order: ParsedOrder = {
        rowIndex: r,
        SKU物品编码: vals[fieldIdx["编码"] ?? -1] || "",
        SKU物品名称: vals[fieldIdx["名称"] ?? -1] || "",
        SKU发货数量: parseFloat(vals[fieldIdx["数量"] ?? -1] || "0") || 0,
        SKU规格型号: vals[fieldIdx["规格"] ?? -1] || "",
        收货门店,
        收件人姓名,
        收件人电话,
        收件人地址,
        _source: card.startRow + "-" + r,
      };

      if (order.SKU物品编码 || order.SKU物品名称) {
        allOrders.push(order);
      }
    }
  }

  return allOrders;
}

// ----- 多Sheet处理 -----
function applyMultiSheet(rule: ParseRule, rawFile: RawFile): ParsedOrder[] {
  const allOrders: ParsedOrder[] = [];

  for (const sheet of rawFile.sheets) {
    let orders = parseSheet(rule, sheet, sheet.name);

    // Apply footer extraction for each sheet
    applyFooterExtraction(rule, sheet, orders);

    // For multi-sheet mode, extract store info from sheet name and footer
    if (rule.multiSheet?.enabled && rule.multiSheet.extractStoreName) {
      // 门店名优先取 Sheet 名称
      const storeName = sheet.name.trim();

      // 同时尝试从尾部提取联系人信息
      const lastRows = sheet.rows.slice(-6);
      let contactName = "", contactPhone = "", contactAddr = "";

      for (const lr of lastRows) {
        if (!lr) continue;
        const vals = lr.map((v) => (v === null ? "" : String(v).trim()));
        for (let i = 0; i < vals.length; i++) {
          if (vals[i].includes("联系人") && i + 1 < vals.length) contactName = vals[i + 1];
          if ((vals[i].includes("联系电话") || vals[i].includes("电话")) && i + 1 < vals.length) contactPhone = vals[i + 1];
          if (vals[i].includes("收货地址") && i + 1 < vals.length) contactAddr = vals[i + 1];
        }
      }

      // 如果尾部没有提取到收货信息，尝试从首行标题提取
      if (!contactName) {
        const titleRow = sheet.rows[0];
        if (titleRow && titleRow[0]) {
          const title = String(titleRow[0]);
          const nameMatch = title.match(/收货人[：:]\\s*(\\S+)/);
          if (nameMatch) contactName = nameMatch[1];
        }
      }

      // 将信息填充到该 Sheet 的所有订单
      for (const order of orders) {
        order.收货门店 = storeName;
        if (contactName) order.收件人姓名 = contactName;
        if (contactPhone) order.收件人电话 = contactPhone;
        if (contactAddr) order.收件人地址 = contactAddr;
      }
    }

    allOrders.push(...orders);
  }

  return allOrders;
}

// ----- 纯文本解析（Word 无表格）-----
function applyTextParse(rule: ParseRule, fileText: string): ParsedOrder[] {
  if (!rule.textParse?.enabled) return [];

  const { recordSeparator, fieldPatterns, skipLines } = rule.textParse;
  const lines = fileText.split("\n");
  const startLine = skipLines || 0;

  // Split by separator into records
  const records: string[] = [];
  let currentRecord: string[] = [];

  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (recordSeparator && line.includes(recordSeparator)) {
      if (currentRecord.length > 0) {
        records.push(currentRecord.join("\n"));
        currentRecord = [];
      }
    } else {
      currentRecord.push(line);
    }
  }
  if (currentRecord.length > 0) {
    records.push(currentRecord.join("\n"));
  }

  // Parse each record using field patterns
  const orders: ParsedOrder[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const order: ParsedOrder = {
      rowIndex: i,
      SKU物品编码: "",
      SKU物品名称: "",
      SKU发货数量: 0,
    };

    let hasData = false;
    for (const pattern of fieldPatterns) {
      try {
        const regex = new RegExp(pattern.pattern, "i");
        const match = record.match(regex);
        if (match && match[pattern.extractGroup]) {
          const value = match[pattern.extractGroup].trim();
          if (pattern.targetField === "SKU发货数量") {
            order.SKU发货数量 = parseFloat(value) || 0;
          } else {
            (order as any)[pattern.targetField] = value;
          }
          hasData = true;
        }
      } catch (e) {
        console.warn(`Invalid regex pattern for ${pattern.name}: ${pattern.pattern}`);
      }
    }

    if (hasData && (order.SKU物品编码 || order.SKU物品名称)) {
      orders.push(order);
    }
  }

  return orders;
}

// ----- 复合单元格拆分 -----
function applyCellSplit(rule: ParseRule, orders: ParsedOrder[]): ParsedOrder[] {
  if (!rule.cellSplit?.enabled || !rule.cellSplit.columns.length) return orders;

  const result: ParsedOrder[] = [];

  for (const order of orders) {
    let expanded = false;

    for (const colConfig of rule.cellSplit.columns) {
      const sourceValue = (order as any)[colConfig.sourceColumn];
      if (!sourceValue || typeof sourceValue !== "string") continue;

      const parts = sourceValue.split(colConfig.separator).filter(Boolean);
      if (parts.length <= 1) continue;

      // Expand into multiple orders
      for (const part of parts) {
        const newOrder = { ...order };
        const trimmedPart = part.trim();
        if (!trimmedPart) continue;

        // Apply field mappings from split parts
        for (const mapping of colConfig.fieldMapping) {
          if (mapping.index < 0 || mapping.index >= parts.length) continue;

          let value = parts[mapping.index].trim();

          // Apply pattern if specified
          if (mapping.pattern) {
            try {
              const regex = new RegExp(mapping.pattern, "i");
              const match = value.match(regex);
              if (match) {
                value = match[1] || match[0];
              }
            } catch (e) {
              // Invalid regex, use raw value
            }
          }

          if (mapping.targetField === "SKU发货数量") {
            (newOrder as any)[mapping.targetField] = parseFloat(value) || 0;
          } else {
            (newOrder as any)[mapping.targetField] = value;
          }
        }

        // Clear the source column value
        delete (newOrder as any)[colConfig.sourceColumn];
        result.push(newOrder);
        expanded = true;
      }
    }

    if (!expanded) {
      result.push(order);
    }
  }

  return result;
}

// ----- PDF 多订单切分 -----
function splitPdfOrders(rule: ParseRule, fileText: string, rawFile: RawFile): ParsedOrder[] {
  if (!rule.pdfConfig?.multiOrder) return [];

  const { orderSeparator } = rule.pdfConfig;
  if (!orderSeparator) return [];

  // Split text by separator
  const sections = fileText.split(orderSeparator).filter((s) => s.trim());

  const allOrders: ParsedOrder[] = [];

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i].trim();
    if (!section) continue;

    // Parse each section as a mini-document
    const sectionLines = section.split("\n").filter((l) => l.trim());

    // Extract receiver info from the section
    let receiverName = "";
    let receiverPhone = "";
    let receiverAddress = "";
    let storeName = "";

    for (const line of sectionLines) {
      const l = line.trim();
      if (l.includes("收货人") || l.includes("收件人")) {
        const match = l.match(/[：:]\s*(.+)/);
        if (match) receiverName = match[1].trim();
      }
      if (l.includes("电话") || l.includes("手机")) {
        const match = l.match(/[：:]\s*(\S+)/);
        if (match) receiverPhone = match[1].trim();
      }
      if (l.includes("地址")) {
        const match = l.match(/[：:]\s*(.+)/);
        if (match) receiverAddress = match[1].trim();
      }
      if (l.includes("门店") || l.includes("收货机构")) {
        const match = l.match(/[：:]\s*(.+)/);
        if (match) storeName = match[1].trim();
      }
    }

    // Extract table data
    const tableStart = sectionLines.findIndex((l) => l.includes("编码") || l.includes("名称") || l.includes("序号"));
    if (tableStart < 0) continue;

    const headerLine = sectionLines[tableStart];
    const headers = headerLine.split(/\s{2,}|\t/).map((h) => h.trim());

    // Find column indices
    let codeIdx = -1, nameIdx = -1, qtyIdx = -1, specIdx = -1;
    headers.forEach((h, idx) => {
      if (h.includes("编码")) codeIdx = idx;
      else if (h.includes("名称")) nameIdx = idx;
      else if (h.includes("数量")) qtyIdx = idx;
      else if (h.includes("规格")) specIdx = idx;
    });

    // Parse data rows
    for (let r = tableStart + 1; r < sectionLines.length; r++) {
      const line = sectionLines[r].trim();
      if (!line || line.includes("签收")) continue;
      // 汇总行检测：扫描整行
      const summaryTerms = ["合计", "总计", "共计", "小计", "汇总", "总调拨", "总数量"];
      if (summaryTerms.some(t => line.includes(t))) continue;

      const cells = line.split(/\s{2,}|\t/).map((c) => c.trim());
      if (cells.length < 2) continue;

      const order: ParsedOrder = {
        rowIndex: allOrders.length,
        SKU物品编码: codeIdx >= 0 ? cells[codeIdx] || "" : "",
        SKU物品名称: nameIdx >= 0 ? cells[nameIdx] || "" : "",
        SKU发货数量: qtyIdx >= 0 ? parseFloat(cells[qtyIdx]) || 0 : 0,
        SKU规格型号: specIdx >= 0 ? cells[specIdx] || "" : "",
        收件人姓名: receiverName,
        收件人电话: receiverPhone,
        收件人地址: receiverAddress,
        收货门店: storeName,
        外部编码: `PDF-${i + 1}`,
      };

      if (order.SKU物品编码 || order.SKU物品名称) {
        allOrders.push(order);
      }
    }
  }

  return allOrders;
}

// ===== 主执行入口 =====
export async function executeRule(rule: ParseRule, rawFile: RawFile): Promise<ParsedOrder[]> {
  let orders: ParsedOrder[] = [];

  console.log("[executeRule] Starting:", {
    ruleName: rule.name,
    fileType: rawFile.fileType,
    sheets: rawFile.sheets.length,
    sheetNames: rawFile.sheets.map(s => s.name),
    firstSheetRows: rawFile.sheets[0]?.rows.length,
    firstSheetCols: rawFile.sheets[0]?.maxCol,
    hasCardBoundary: !!rule.cardBoundary?.enabled,
    hasMultiSheet: !!rule.multiSheet?.enabled,
    hasMatrixTranspose: !!rule.matrixTranspose?.enabled,
    hasAggregation: !!rule.aggregation?.enabled,
    hasFooterExtraction: !!rule.footerExtraction?.enabled,
    hasTextParse: !!rule.textParse?.enabled,
    hasPdfMultiOrder: !!rule.pdfConfig?.multiOrder,
    columnMappings: rule.columnMappings.map(m => `${m.sourceField}→${m.targetField}`),
    headerRow: rule.header?.headerRow,
  });

  // PDF 多订单切分（优先处理）
  if (rule.pdfConfig?.multiOrder && rawFile.fileType === "pdf") {
    const fileText = rawFile.sheets.map((s) =>
      s.rows.map((r) => r.map((c) => (c === null ? "" : String(c))).join("\t")).join("\n")
    ).join("\n");
    const pdfOrders = splitPdfOrders(rule, fileText, rawFile);
    if (pdfOrders.length > 0) {
      return pdfOrders;
    }
  }

  // Word 纯文本解析
  if (rule.textParse?.enabled && rawFile.fileType === "word") {
    const fileText = rawFile.sheets.map((s) =>
      s.rows.map((r) => r.map((c) => (c === null ? "" : String(c))).join(" ")).join("\n")
    ).join("\n");
    const textOrders = applyTextParse(rule, fileText);
    if (textOrders.length > 0) {
      return textOrders;
    }
  }

  if (rule.cardBoundary?.enabled) {
    // Card mode processes sheets directly
    for (const sheet of rawFile.sheets) {
      const cardOrders = applyCardBoundary(rule, sheet);
      orders.push(...cardOrders);
    }
  } else if (rule.multiSheet?.enabled) {
    // Multi-sheet mode
    orders = applyMultiSheet(rule, rawFile);
  } else {
    // Standard mode: parse first matching sheet
    for (const sheet of rawFile.sheets) {
      const sheetOrders = parseSheet(rule, sheet, sheet.name);

      // Apply footer extraction
      applyFooterExtraction(rule, sheet, sheetOrders);

      orders.push(...sheetOrders);
    }
  }

  // Apply aggregation (post-processing)
  orders = applyAggregation(rule, orders);

  // Apply matrix transpose (post-processing)
  if (rule.matrixTranspose?.enabled) {
    const result: ParsedOrder[] = [];
    for (const order of orders) {
      let transposed = false;
      const dimCols: number[] = rule.matrixTranspose.dimensionColumns;
      for (const colIdx of dimCols) {
        const vals = Object.values(order);
        if (colIdx < vals.length && vals[colIdx] !== undefined && vals[colIdx] !== null) {
          const storeName = String(vals[colIdx]).trim();
          if (storeName && !["0", "NaN", ""].includes(storeName)) {
            const newOrder = { ...order, rowIndex: order.rowIndex };
            delete (newOrder as any)[colIdx];
            (newOrder as any)[rule.matrixTranspose.dimensionField] = storeName;
            result.push(newOrder);
            transposed = true;
          }
        }
      }
      if (!transposed) {
        result.push(order);
      }
    }
    orders = result;
  }

  // Apply cell split (post-processing)
  if (rule.cellSplit?.enabled) {
    orders = applyCellSplit(rule, orders);
  }

  return orders;
}
