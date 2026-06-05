// ===== 规则引擎核心类型定义 =====
// 核心设计理念：通用规则描述语言（Rule Description Language）
// 不是硬编码解析逻辑，而是通过配置规则来适配任意格式

// ------ 字段映射 ------
export interface ColumnMapping {
  sourceField: string;        // 源字段名（表头文本或字段索引）
  targetField: string;        // 目标字段（外部编码, 收货门店, 收件人姓名, 收件人电话, 收件人地址, SKU物品编码, SKU物品名称, SKU发货数量, SKU规格型号, 备注）
  isRequired?: boolean;       // 是否必填
  defaultValue?: string;      // 默认值
  transform?: string;         // 转换表达式（如 "trim", "toNumber"）
  isStatic?: boolean;         // 是否为静态值（非从文件读取）
  description?: string;       // 映射说明
  aiConfidence?: number;      // AI 置信度 0-1
}

// ------ 文件类型 ------
export type FileType = "excel" | "word" | "pdf";

// ------ 头部跳过 ------
export interface HeaderConfig {
  skipRows: number;           // 表头前跳过的行数
  headerRow: number;          // 表头所在行号（0-based）
}

// ------ 尾部信息提取（黎明屯、多门店Sheet、卡片式等） ------
export interface FooterExtractionConfig {
  enabled: boolean;
  sections: FooterSection[];  // 尾部信息区域定义
}

export interface FooterSection {
  name: string;               // 区域名称（如"收货信息"）
  startKeyword: string;       // 开始关键词（如"收货人"）
  fields: FooterFieldMapping[]; 
}

export interface FooterFieldMapping {
  keyword: string;            // 关键词（如"收货人"）
  targetField: string;        // 目标字段
  offset: number;             // 值在同行中的列偏移
  aiConfidence?: number;
}

// ------ 跨行聚合（湖南仓） ------
export interface AggregationConfig {
  enabled: boolean;
  groupByField: string;       // 聚合依据字段（如"配送单号"）
  sharedFields: string[];     // 共享字段列表（收货人、收货电话等）
}

// ------ 矩阵转置（欢乐牧场、周配送计划） ------
export interface MatrixTransposeConfig {
  enabled: boolean;
  dimensionColumns: number[];   // 维度列索引（即门店名所在的列索引）
  dimensionField: string;       // 转置后的维度字段名
  quantityField: string;        // 转置后的数量字段名
  excludeEmpty: boolean;        // 是否排除空值
  sourceDimensionName?: string; // 维度的名称（如"门店"、"星期"）
}

// ------ 多Sheet配置（多门店分Sheet） ------
export interface MultiSheetConfig {
  enabled: boolean;
  sheetNamePattern?: string;    // Sheet名称匹配模式（正则）
  extractStoreName?: boolean;   // 是否从Sheet名提取门店名
  storeNameField?: string;      // 门店名映射到的目标字段
}

// ------ 卡片模式配置（门店调拨单-卡片式） ------
export interface CardBoundaryConfig {
  enabled: boolean;
  startPattern: string;         // 卡片起始正则（如"▶ 调拨记录"）
  headerRowCount: number;       // 卡片头部行数（含标题行后的收货信息行）
  dataHeaderRowCount: number;   // 数据表头行数
  dataStartOffset: number;      // 数据从卡片起始后的第几行开始
}

// ------ PDF 配置 ------
export interface PdfConfig {
  headerSkipLines: number;      // 跳过开头的行数（元信息）
  tableHeaderPattern?: string;  // 表格表头匹配模式（如 "物品类别|序号"）
  footerKeyword?: string;       // 底部信息关键词（如"收货人"）
  multiOrder?: boolean;         // 是否多单PDF
  orderSeparator?: string;      // 多单分隔符
}

// ------ 纯文本解析配置（Word无表格） ------
export interface TextParseConfig {
  enabled: boolean;
  recordSeparator?: string;     // 记录分隔符（如"━━━"）
  fieldPatterns: FieldPattern[]; // 字段提取模式
  skipLines?: number;           // 跳过前N行
}

export interface FieldPattern {
  name: string;
  targetField: string;
  pattern: string;              // 正则表达式
  extractGroup: number;         // 提取的捕获组索引
  isRequired?: boolean;
  aiConfidence?: number;
}

// ------ 复合单元格拆分配置 ------
export interface CellSplitConfig {
  enabled: boolean;
  columns: CellSplitColumn[];
}

export interface CellSplitColumn {
  sourceColumn: string;         // 复合值所在列
  separator: string;            // 分隔符（如"\n"、","）
  fieldMapping: SplitFieldMapping[];
}

export interface SplitFieldMapping {
  index: number;                // 拆分后第几个元素
  targetField: string;
  pattern?: string;             // 可选：拆分行内再提取的正则（如"x"分割数量）
}

// ===== 主规则定义 =====
export interface ParseRule {
  id: string;
  name: string;                 // 规则名称
  description: string;
  fileType: FileType;
  createdAt: string;
  updatedAt: string;
  aiGenerated?: boolean;        // 是否为AI生成
  aiPrompt?: string;            // AI生成时的prompt

  // === 规则配置项 ===
  header: HeaderConfig;
  columnMappings: ColumnMapping[];

  // 高级配置（按需启用）
  footerExtraction?: FooterExtractionConfig;
  aggregation?: AggregationConfig;
  matrixTranspose?: MatrixTransposeConfig;
  multiSheet?: MultiSheetConfig;
  cardBoundary?: CardBoundaryConfig;
  pdfConfig?: PdfConfig;
  textParse?: TextParseConfig;
  cellSplit?: CellSplitConfig;
}

// ===== 解析结果 =====
export interface ParsedOrder {
  rowIndex: number;
  外部编码?: string;
  收货门店?: string;
  收件人姓名?: string;
  收件人电话?: string;
  收件人地址?: string;
  SKU物品编码: string;
  SKU物品名称: string;
  SKU发货数量: number;
  SKU规格型号?: string;
  备注?: string;
  // 源数据
  _source?: string;
  _sheetName?: string;
  _sourceFile?: string;         // 来源文件名
  _batchId?: string;            // 批次ID
  _createdAt?: string;          // 创建时间
  // 校验
  _errors?: ValidationError[];
  _duplicate?: boolean;
  _duplicateWith?: string;
}

export interface ValidationError {
  field: string;
  message: string;
  rowIndex: number;
}

// ===== 规则模板（用于AI生成） =====
export interface RuleTemplate {
  name: string;
  description: string;
  fileType: FileType;
  config: Partial<ParseRule>;
}

// ===== API类型 =====
export interface OrderSubmitPayload {
  batchId: string;
  orders: ParsedOrder[];
  submittedAt: string;
}
