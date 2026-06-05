// Debug script to test parseSheet with mock data
const { executeRule } = require('./src/lib/rule-engine/rule-executor.ts');

// Mock raw file matching the user's Excel structure
const mockRawFile = {
  fileType: "excel",
  fileName: "test.xlsx",
  sheets: [{
    name: "Sheet1",
    rows: [
      // Row 0: interference header
      ["公司名称", "日期", "", "", "", "", "", "", "", ""],
      // Row 1: actual header
      ["收货机构", "配送汇总单号*", "物品编码*", "物品名称", "规格型号", "应发数量", "单据备注", "收货人", "收货电话", "收货地址"],
      // Row 2: data
      ["门店A", "DH2024001", "SKU001", "苹果", "1kg", 10, "", "张三", "13800138000", "北京市"],
      // Row 3: data (same order)
      ["门店A", "DH2024001", "SKU002", "香蕉", "1kg", 5, "", "张三", "13800138000", "北京市"],
      // Row 4: data (different order)
      ["门店B", "DH2024002", "SKU003", "橙子", "500g", 8, "", "李四", "13900139000", "上海市"],
    ],
    maxCol: 9
  }]
};

// Rule from the screenshot
const mockRule = {
  id: "test",
  name: "测试规则",
  description: "",
  fileType: "excel",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  header: { skipRows: 1, headerRow: 1 },
  columnMappings: [
    { sourceField: "收货机构", targetField: "收货门店" },
    { sourceField: "配送汇总单号*", targetField: "外部编码" },
    { sourceField: "物品编码*", targetField: "SKU物品编码", isRequired: true },
    { sourceField: "物品名称", targetField: "SKU物品名称", isRequired: true },
    { sourceField: "规格型号", targetField: "SKU规格型号" },
    { sourceField: "应发数量", targetField: "SKU发货数量", isRequired: true, transform: "toNumber" },
    { sourceField: "单据备注", targetField: "备注" },
    { sourceField: "收货人", targetField: "收件人姓名" },
    { sourceField: "收货电话", targetField: "收件人电话" },
    { sourceField: "收货地址", targetField: "收件人地址" },
  ],
  aggregation: {
    enabled: true,
    groupByField: "外部编码",
    sharedFields: ["收件人姓名", "收件人电话", "收件人地址", "收货门店"]
  }
};

executeRule(mockRule, mockRawFile).then(orders => {
  console.log("Result:", orders.length, "orders");
  orders.forEach((o, i) => {
    console.log(`Order ${i}:`, {
      外部编码: o.外部编码,
      SKU编码: o.SKU物品编码,
      SKU名称: o.SKU物品名称,
      数量: o.SKU发货数量,
      收货人: o.收件人姓名,
    });
  });
}).catch(err => {
  console.error("Error:", err);
});
