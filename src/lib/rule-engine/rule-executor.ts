// ===== 规则执行器 =====
// 根据 ParseRule 配置，将 RawFile 解析为结构化运单数据
// 支持：头部跳过 → 列映射 → 尾部提取 → 跨行聚合 → 矩阵转置 → 卡片模式 → 多Sheet → 复合单元格拆分

import type { ParseRule, ParsedOrder } from "./types";
import type { RawFile, RawSheet } from "./file-parser";

// ----- 从规则获取源列索引 -----
function findColumnIndex(sheet: RawSheet, headerRow: number, fieldName: string): number {
  const row = sheet.rows[headerRow];
  if (!row) return -1;
  for (let c = 0; c < row.length; c++) {
    if (row[c] !== null && String(row[c]).trim() === fieldName) return c;
  }
  return -1;
}

function findColumnIndexByNumber(sheet: RawSheet, colIndex: number): boolean {
  return colIndex >= 0 && colIndex <= (sheet.maxCol || 0);
}

// ----- 解析单个 Sheet -----
function parseSheet(rule: ParseRule, sheet: RawSheet, _sheetName: string): ParsedOrder[] {
  const { header, columnMappings } = rule;
  const dataStartRow = header.headerRow + 1;
  const orders: ParsedOrder[] = [];

  // Build field → column index mapping
  const fieldMap = new Map<string, { colIndex: number; mapping: typeof columnMappings[0] }>();

  for (const mapping of columnMappings) {
    if (mapping.isStatic) continue; // 静态值不参与列映射
    let colIndex = findColumnIndex(sheet, header.headerRow, mapping.sourceField);
    if (colIndex < 0) {
      // Try numeric index
      const num = parseInt(mapping.sourceField);
      if (!isNaN(num)) colIndex = num;
    }
    fieldMap.set(mapping.targetField, { colIndex, mapping });
  }

  // Process data rows
  for (let r = dataStartRow; r < sheet.rows.length; r++) {
    const row = sheet.rows[r];

    // Skip empty rows
    if (!row || row.every((c) => c === null || c === "")) continue;

    // Skip 合计/合计行
    const firstCell = row[0] ? String(row[0]).trim() : "";
    if (firstCell === "合计" || firstCell === "合" || firstCell === "总计") continue;

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
    if (!order.SKU物品编码 && !order.SKU物品名称 && !order.SKU物品名称?.trim()) continue;

    orders.push(order);
  }

  return orders;
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

// ----- 跨行聚合 -----
function applyAggregation(rule: ParseRule, orders: ParsedOrder[]): ParsedOrder[] {
  if (!rule.aggregation?.enabled) return orders;

  const groupField = rule.aggregation.groupByField;
  const sharedFields = rule.aggregation.sharedFields;
  const groups = new Map<string, ParsedOrder[]>();

  // Group by key
  for (const order of orders) {
    const key = String((order as any)[groupField] || "");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(order);
  }

  // For each group, fill shared fields from the first item
  const result: ParsedOrder[] = [];
  for (const [, group] of groups) {
    if (group.length === 0) continue;
    const first = group[0];
    for (const order of group) {
      for (const field of sharedFields) {
        const val = (first as any)[field];
        if (val && !(order as any)[field]) {
          (order as any)[field] = val;
        }
      }
      result.push(order);
    }
  }

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
      if (vals[0] === "合计") continue;

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

    // For multi-sheet mode, try to extract store name from sheet
    if (rule.multiSheet?.enabled && rule.multiSheet.extractStoreName) {
      // Store name is in the sheet title (first row)
      const titleRow = sheet.rows[0];
      if (titleRow && titleRow[0]) {
        const title = String(titleRow[0]);
        // Extract store name from title like "尹三顺自助烤肉（银泰店）出库单"
        const match = title.match(/^(.+?)出库单/);
        if (match) {
          const storeName = match[1].trim();
          for (const order of orders) {
            order.收货门店 = storeName;
          }
        }
      }

      // Try to extract contact info from footer rows
      // Footer typically has: Row 14-15 with 收货门店, 联系人, 联系电话, 收货地址
      const lastRows = sheet.rows.slice(-5);
      let 联系人 = "", 联系电话 = "", 收货地址 = "";
      for (const lr of lastRows) {
        if (!lr) continue;
        const vals = lr.map((v) => (v === null ? "" : String(v).trim()));
        for (let i = 0; i < vals.length; i++) {
          if (vals[i].includes("联系人") && i + 1 < vals.length) 联系人 = vals[i + 1];
          if (vals[i].includes("联系电话") && i + 1 < vals.length) 联系电话 = vals[i + 1];
          if (vals[i].includes("收货地址") && i + 1 < vals.length) 收货地址 = vals[i + 1];
          if (vals[i].includes("收货门店") && i + 1 < vals.length) {
            if (!orders[0]?.收货门店) {
              for (const o of orders) o.收货门店 = vals[i + 1];
            }
          }
        }
      }
      if (联系人) for (const o of orders) o.收件人姓名 = 联系人;
      if (联系电话) for (const o of orders) o.收件人电话 = 联系电话;
      if (收货地址) for (const o of orders) o.收件人地址 = 收货地址;
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
      if (!line || line.includes("合计") || line.includes("总计") || line.includes("签收")) continue;

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
