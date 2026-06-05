// ===== 文件解析器 =====
// 负责将不同格式的文件解析为统一的"原始行"格式
// 不涉及规则应用，只做格式层面的读取

import * as XLSX from "xlsx";

export interface CellData {
  value: string | number | null;
  col: number;    // 0-based
  row: number;    // 0-based
}

export interface RawSheet {
  name: string;
  rows: (string | number | null)[][];  // 二维数组
  cells: CellData[];                    // 展平的非空单元格
  maxRow: number;
  maxCol: number;
}

export interface RawFile {
  fileName: string;
  fileType: "excel" | "word" | "pdf";
  sheets: RawSheet[];
}

// ----- Excel 解析 -----
function parseExcel(buffer: ArrayBuffer): RawSheet[] {
  const workbook = XLSX.read(buffer, { type: "array", cellDates: false });
  const sheets: RawSheet[] = [];

  for (const sheetName of workbook.SheetNames) {
    const ws = workbook.Sheets[sheetName];
    const ref = ws["!ref"];
    if (!ref) continue;

    const range = XLSX.utils.decode_range(ref);
    const rows: (string | number | null)[][] = [];
    const cells: CellData[] = [];

    for (let r = range.s.r; r <= range.e.r; r++) {
      const row: (string | number | null)[] = [];
      for (let c = range.s.c; c <= range.e.c; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        const cell = ws[addr];
        let val: string | number | null = null;
        if (cell) {
          if (cell.t === "n") {
            val = cell.v as number;
          } else {
            val = (cell.v ?? "").toString().trim();
            if (val === "") val = null;
          }
        }
        row.push(val);
        if (val !== null) {
          cells.push({ value: val, col: c, row: r });
        }
      }
      rows.push(row);
    }

    sheets.push({ name: sheetName, rows, cells, maxRow: range.e.r, maxCol: range.e.c });
  }

  return sheets;
}

// ----- Word (.docx) 解析（动态导入 mammoth 避免 Node.js 依赖冲突）-----
async function parseWord(buffer: ArrayBuffer): Promise<RawSheet[]> {
  // mammoth is Node.js only, use dynamic import in browser context
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ arrayBuffer: buffer });
  const text = result.value;
  const lines = text.split(/\r?\n/);
  const rows = lines.map((line) => [line]);
  return [
    {
      name: "WordDocument",
      rows: rows.map((r) => [r[0] || null]),
      cells: rows
        .map((r, i) => ({ value: r[0] || "", col: 0, row: i }))
        .filter((c) => c.value !== ""),
      maxRow: rows.length - 1,
      maxCol: 0,
    },
  ];
}

// ----- PDF 解析 -----
async function parsePdf(buffer: ArrayBuffer): Promise<RawSheet[]> {
  // 使用 pdfjs-dist（支持浏览器端）
  const pdfjsLib = await import("pdfjs-dist");

  // 设置 Worker：使用 CDN 版本对应的 pdf.worker.mjs
  const pdfjsVersion = pdfjsLib.version || "4.10.38";
  pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsVersion}/pdf.worker.min.mjs`;

  const pdf = await pdfjsLib.getDocument({ data: buffer.slice(0) }).promise;
  const pages: { text: string; rows: (string | null)[][] }[] = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();

    // 收集所有文本项，按 Y 坐标分行，按 X 坐标分列
    interface TextItem {
      str: string;
      x: number;  // transform[4] - X 坐标
      y: number;  // transform[5] - Y 坐标
      width: number;
    }

    const items: TextItem[] = [];
    for (const item of content.items as { str: string; transform: number[]; width?: number }[]) {
      if (!item.str || !item.str.trim()) continue;
      items.push({
        str: item.str.trim(),
        x: Math.round(item.transform[4]),
        y: Math.round(item.transform[5]),
        width: item.width || 0,
      });
    }

    if (items.length === 0) {
      pages.push({ text: "", rows: [] });
      continue;
    }

    // 按 Y 坐标分行（允许 ±3 像素误差）
    const yGroups: TextItem[][] = [];
    let currentGroup: TextItem[] = [items[0]];
    let currentY = items[0].y;

    for (let j = 1; j < items.length; j++) {
      if (Math.abs(items[j].y - currentY) <= 3) {
        currentGroup.push(items[j]);
      } else {
        yGroups.push(currentGroup);
        currentGroup = [items[j]];
        currentY = items[j].y;
      }
    }
    yGroups.push(currentGroup);

    // 对每行：按 X 坐标排序，然后用 X 间距分列
    const lines: string[] = [];
    const rows: (string | null)[][] = [];

    for (const group of yGroups) {
      // 按 X 排序
      group.sort((a, b) => a.x - b.x);

      // 用 X 间距分列：如果两个相邻项的 X 间距 > 平均字符宽度的 2 倍，认为是不同列
      const cols: string[] = [];
      let colText = group[0].str;
      let lastX = group[0].x;
      let lastWidth = group[0].width || group[0].str.length * 8; // 估计宽度

      for (let k = 1; k < group.length; k++) {
        const gap = group[k].x - (lastX + lastWidth);
        // 间距 > 8px 认为是新列（约 1 个中文字符宽度）
        if (gap > 8) {
          cols.push(colText.trim());
          colText = group[k].str;
        } else {
          // 同列内，文本拼接
          colText += group[k].str;
        }
        lastX = group[k].x;
        lastWidth = group[k].width || group[k].str.length * 8;
      }
      if (colText.trim()) cols.push(colText.trim());

      // 行文本（用于 footerExtraction 等纯文本搜索）
      lines.push(cols.join("  "));

      // 行数据
      if (cols.length > 1) {
        rows.push(cols.map(s => s || null));
      } else {
        rows.push([cols[0] || null]);
      }
    }

    pages.push({
      text: lines.join("\n"),
      rows,
    });
  }

  // 将所有页面合并为一个 sheet
  const allRows: (string | null)[][] = [];
  for (let pi = 0; pi < pages.length; pi++) {
    if (pi > 0) allRows.push([`--- PAGE BREAK ${pi + 1} ---`]);
    allRows.push(...pages[pi].rows);
  }

  const cells: CellData[] = [];
  allRows.forEach((row, ri) => {
    row.forEach((val, ci) => {
      if (val !== null) cells.push({ value: val, col: ci, row: ri });
    });
  });

  return [
    {
      name: "PDF",
      rows: allRows,
      cells,
      maxRow: allRows.length - 1,
      maxCol: Math.max(...allRows.map((r) => r.length), 0) - 1,
    },
  ];
}

// ----- 主入口 -----
export async function parseFile(
  file: File,
  buffer: ArrayBuffer
): Promise<RawFile> {
  const name = file.name.toLowerCase();

  if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
    return {
      fileName: file.name,
      fileType: "excel",
      sheets: parseExcel(buffer),
    };
  } else if (name.endsWith(".docx")) {
    return {
      fileName: file.name,
      fileType: "word",
      sheets: await parseWord(buffer),
    };
  } else if (name.endsWith(".pdf")) {
    return {
      fileName: file.name,
      fileType: "pdf",
      sheets: await parsePdf(buffer),
    };
  }

  throw new Error(`不支持的文件格式: ${name}`);
}

// ----- 工具：将 RawFile 转换为纯文本（用于 AI 分析）-----
export function rawFileToText(raw: RawFile, maxRows: number = 60): string {
  const parts: string[] = [];
  parts.push(`文件名称: ${raw.fileName}`);
  parts.push(`文件类型: ${raw.fileType}`);
  parts.push("");

  for (const sheet of raw.sheets.slice(0, 3)) {
    parts.push(`--- Sheet: ${sheet.name} (${sheet.rows.length}行 x ${sheet.maxCol + 1}列) ---`);
    const rows = sheet.rows.slice(0, maxRows);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
        .map((v) => (v === null ? "" : String(v)).substring(0, 30))
        .join(" | ");
      if (row.replace(/\|\s*/g, "").trim()) {
        parts.push(`行${i}: ${row}`);
      }
    }
    if (sheet.rows.length > maxRows) {
      parts.push(`... (共 ${sheet.rows.length} 行)`);
    }
    parts.push("");
  }

  return parts.join("\n");
}
