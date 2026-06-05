# 第七轮修复 — 按外部编码聚合出库单 + AI 修复 + 预览页重构

## 完成内容

### 1. AI 模型测试 ✅
- curl 直接测试 mimo-v2.5-pro（TokenPlan/小米）→ 正常返回
- 模型无问题，baseUrl `https://token-plan-cn.xiaomimimo.com/v1` 可用

### 2. AI max_tokens 修复
- `max_tokens: 2500` → `8000`
- mimo-v2.5-pro 是 reasoning 模型，会先输出 `reasoning_content` 再输出正式内容，2500 tokens 不够用

### 3. groupByField 关键 Bug 修复
- **根因**: `aggregation.groupByField` 存的是 sourceField（如"配送单号"），但 `parseSheet()` 输出的 ParsedOrder 用的是 targetField（如"外部编码"）→ `applyAggregation` 用 `(order as any)[groupField]` 永远是 undefined → 聚合失效
- **修复**: 始终按 targetField `"外部编码"` 分组，不再依赖 sourceField

### 4. applyAggregation 彻底重写
- **按外部编码分组**: 同一外部编码下的 SKU 行共享收货信息，展示为一个出库单
- **SKU 去重合并**: 相同 SKU物品编码 → 数量求和，补充缺失名称/规格
- **收货信息共享**: 取组内第一个非空值，强制统一到整组
- **O(n) Map 复杂度**: 性能优化
- **分组标记**: `_groupKey` / `_groupSize` / `_groupIndex` 供 UI 使用

### 5. 预览页重构（出库单分组卡片展示）
- 每个出库单 = 一个可折叠卡片
  - 头部：外部编码 + 收货信息摘要 + SKU数量 badge
  - 收货信息栏：可编辑，修改同步到整组
  - SKU 明细表：编号、操作、SKU编码/名称/数量/规格/备注
- 重复标记：历史重复(红) / 同批次重复(黄)
- 分页：每页 20 个出库单分组
- 统计：共 N 个出库单 · M 条 SKU 记录

### 6. 部署
- git push → Vercel 自动部署
- 清理了 git history 中的 Vercel token secret
- 生产地址: https://20260605135655.vercel.app
