# 万能导入 V2 — Bug 修复总结

## 修复日期
2026-06-05

## 修复内容

### Bug 1: AI 生成规则解析总是返回空结果 🔴 Critical

**根因**: `ai-service.ts` 中的 `localAnalyze()` 函数使用文本行索引(`headerRowIdx`)作为 Excel 实际行号，导致 `headerRow` 偏移错误。例如文件有 3 行前置信息（文件名/类型/Sheet标记），真实的表头在第 1 行，但 `headerRow` 被设为 4（文本数组索引），导致 `parseSheet` 在错误的行读取列头，全部列匹配失败 → 零结果。

**修复**:
- `ai-service.ts`: `localAnalyze()` 现在从 "行N:" 前缀解析出实际行号，不再使用文本数组索引
- `rule-executor.ts`: 新增 `findColumnByTargetField()` 兜底函数——当 AI 返回的 `sourceField` 匹配不到时，直接用 `targetField` 的同义词搜索列头
- `rule-executor.ts`: `findColumnIndex()` 新增规范化匹配步骤（Step 1.5），处理 `"物品编码*"` vs `"物品编码"` 这类特殊字符差异
- `rule-executor.ts`: `buildFieldMap()` 增加三级兜底：sourceField匹配 → targetField同义词 → 数字列索引

### Bug 2: 汇总行被错误解析为数据行 🟡 Medium

**问题**: 调拨单格式中的汇总行（如 "合计：3 个门店 | 9 种物品 | 总调拨数量：44 件/包"）只检查了第0列，漏检了分散在其他列的汇总信息。

**修复**:
- `rule-executor.ts`: 新增 `isSummaryRow()` 函数，扫描整行所有单元格
- 关键词覆盖：合计/总计/共计/小计/累计/汇总/总调拨数量/总数量/总金额
- 正则模式：`\d+ 个 (门店|仓库|站点|店铺)`、`\d+ 种 (物品|商品|SKU)`、`总(调拨|发货|出库|入库)数量[：:]`
- 同步修复 `applyCardBoundary()` 和 `splitPdfOrders()` 中的汇总行检测

### Bug 3: 考试要求合规性检查 ✅ Pass

- 无文件名判断（grep fileName.includes/match/indexOf 返回空）
- 无硬编码列名在解析逻辑中（列映射全部通过规则配置，而非条件判断）
- 预置规则(presets.ts)中的列名属于规则配置范畴，符合"通过配置规则实现兼容"的要求

## 涉及文件

| 文件 | 修改内容 |
|------|---------|
| `src/lib/rule-engine/rule-executor.ts` | 新增 `findColumnByTargetField()`、`isSummaryRow()`，增强 `buildFieldMap()` 和 `findColumnIndex()` |
| `src/lib/ai/ai-service.ts` | 修复 `localAnalyze()` 的 `headerRow` 行号提取（从文本行索引改为实际 Excel 行号） |

## 构建状态
✅ `next build` 编译成功，无 TypeScript 错误

## 部署
⚠️ Vercel token 过期，需运行 `vercel login` 重新认证后部署
