// ===== 预置规则（基于 demo 文件分析）=====
// 注意：这些规则是通过分析文件结构配置的，不是硬编码解析逻辑
// 每种新格式只需增加一条规则配置即可适配

import type { ParseRule } from "./types";
import { generateId } from "../store";

export function getDefaultRules(): ParseRule[] {
  return [
    // 1. 黎明屯配送发货单 - Excel 42列，3行干扰头部，尾部收货人散落
    {
      id: "preset_liming",
      name: "黎明屯配送发货单解析",
      description: "适配黎明屯配送发货单格式：42列宽表，表头在第4行，收货人信息在表格底部独立行",
      fileType: "excel",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      aiGenerated: false,
      header: { skipRows: 3, headerRow: 3 },
      columnMappings: [
        { sourceField: "物品编码", targetField: "SKU物品编码", isRequired: true },
        { sourceField: "物品名称", targetField: "SKU物品名称", isRequired: true },
        { sourceField: "规格型号", targetField: "SKU规格型号" },
        { sourceField: "发货数量", targetField: "SKU发货数量", isRequired: true, transform: "toNumber" },
        { sourceField: "备注", targetField: "备注" },
      ],
      footerExtraction: {
        enabled: true,
        sections: [
          {
            name: "收货信息",
            startKeyword: "收货人",
            fields: [
              { keyword: "收货人", targetField: "收件人姓名", offset: 1 },
              { keyword: "收货电话", targetField: "收件人电话", offset: 1 },
              { keyword: "收货地址", targetField: "收件人地址", offset: 1 },
            ],
          },
        ],
      },
    },

    // 2. 湖南仓发货明细 - Excel 32列，第1行说明文字第2行表头，每行含收货人，需聚合
    {
      id: "preset_hunan",
      name: "湖南仓发货明细解析",
      description: "适配湖南仓发货明细：每行含完整收货信息，需按配送单号跨行聚合（同单号多行共享收货人）",
      fileType: "excel",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      aiGenerated: false,
      header: { skipRows: 1, headerRow: 1 },
      columnMappings: [
        { sourceField: "配送单号", targetField: "外部编码" },
        { sourceField: "收货机构", targetField: "收货门店" },
        { sourceField: "物品编码*", targetField: "SKU物品编码", isRequired: true },
        { sourceField: "物品名称", targetField: "SKU物品名称", isRequired: true },
        { sourceField: "规格型号", targetField: "SKU规格型号" },
        { sourceField: "发货数量*", targetField: "SKU发货数量", isRequired: true, transform: "toNumber" },
        { sourceField: "收货人", targetField: "收件人姓名" },
        { sourceField: "收货电话", targetField: "收件人电话" },
        { sourceField: "收货地址", targetField: "收件人地址" },
        { sourceField: "单据备注", targetField: "备注" },
      ],
      aggregation: {
        enabled: true,
        groupByField: "配送单号",
        sharedFields: ["收件人姓名", "收件人电话", "收件人地址", "收货门店"],
      },
    },

    // 3. 欢乐牧场模板 - Excel 19列，门店作为列头横向排列，需矩阵转置
    {
      id: "preset_hlmc",
      name: "欢乐牧场库存转配送单解析",
      description: "适配欢乐牧场模板：SKU×门店矩阵格式，需将门店列（银泰/金银潭/金桥/门店B/门店D）转置为独立运单记录",
      fileType: "excel",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      aiGenerated: false,
      header: { skipRows: 0, headerRow: 0 },
      columnMappings: [
        { sourceField: "外部商品编码", targetField: "SKU物品编码", isRequired: true },
        { sourceField: "SKU名称", targetField: "SKU物品名称", isRequired: true },
        { sourceField: "规格", targetField: "SKU规格型号" },
        // 数量 = 门店列的值（通过矩阵转置处理）
      ],
      matrixTranspose: {
        enabled: true,
        dimensionColumns: [13, 14, 15, 16, 17], // 银泰(13), 金银潭(14), 金桥(15), 门店B(16), 门店D(17)
        dimensionField: "收货门店",
        quantityField: "SKU发货数量",
        excludeEmpty: true,
        sourceDimensionName: "门店",
      },
    },

    // 4. 多门店分Sheet出库单 - 3个Sheet，每个Sheet一个门店
    {
      id: "preset_multisheet",
      name: "多门店分Sheet出库单解析",
      description: "适配多门店分Sheet出库单：3个Sheet分别对应3个门店，需从Sheet标题提取门店名，从底部提取收货信息",
      fileType: "excel",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      aiGenerated: false,
      header: { skipRows: 3, headerRow: 3 },
      columnMappings: [
        { sourceField: "物品编码", targetField: "SKU物品编码", isRequired: true },
        { sourceField: "物品名称", targetField: "SKU物品名称", isRequired: true },
        { sourceField: "规格型号", targetField: "SKU规格型号" },
        { sourceField: "出库数量", targetField: "SKU发货数量", isRequired: true, transform: "toNumber" },
        { sourceField: "备注", targetField: "备注" },
      ],
      multiSheet: {
        enabled: true,
        extractStoreName: true,
      },
    },

    // 5. 门店调拨单(卡片式) - 非标准表格，每条记录是独立卡片
    {
      id: "preset_card",
      name: "门店调拨单卡片式解析",
      description: "适配门店调拨单卡片式：每个调拨记录为独立卡片区域，以'▶ 调拨记录 #N'为边界，卡片内包含收货信息和物品小表",
      fileType: "excel",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      aiGenerated: false,
      header: { skipRows: 0, headerRow: 0 },
      columnMappings: [],
      cardBoundary: {
        enabled: true,
        startPattern: "▶ 调拨记录",
        headerRowCount: 2,
        dataHeaderRowCount: 1,
        dataStartOffset: 3,
      },
    },

    // 6. 黔寨寨配送单 PDF - 多页PDF，表格+尾部收货信息
    {
      id: "preset_qianzhai",
      name: "黔寨寨配送单PDF解析",
      description: "适配黔寨寨配送单PDF：2页PDF，首页含元信息和物品表格，尾页底部有收货人信息",
      fileType: "pdf",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      aiGenerated: false,
      header: { skipRows: 1, headerRow: 1 },
      columnMappings: [
        { sourceField: "物品编码", targetField: "SKU物品编码", isRequired: true },
        { sourceField: "物品名称", targetField: "SKU物品名称", isRequired: true },
        { sourceField: "规格型号", targetField: "SKU规格型号" },
        { sourceField: "发货数量", targetField: "SKU发货数量", isRequired: true, transform: "toNumber" },
        { sourceField: "备注", targetField: "备注" },
      ],
      pdfConfig: {
        headerSkipLines: 5,
        tableHeaderPattern: "物品类别",
        footerKeyword: "收货人",
      },
      footerExtraction: {
        enabled: true,
        sections: [
          {
            name: "收货信息",
            startKeyword: "收货人",
            fields: [
              { keyword: "收货人", targetField: "收件人姓名", offset: 0 },
              { keyword: "收货电话", targetField: "收件人电话", offset: 0 },
              { keyword: "收货地址", targetField: "收件人地址", offset: 0 },
            ],
          },
        ],
      },
    },
  ];
}
