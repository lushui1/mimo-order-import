# 考点文档：大模型调用说明

## 一、使用的模型

| 项目 | 说明 |
|------|------|
| **模型名称** | `mimo-v2.5-pro` |
| **模型提供方** | TokenPlan / 小米 |
| **API Base URL** | `https://token-plan-cn.xiaomimimo.com/v1` |
| **接口协议** | OpenAI 兼容 `/chat/completions` |
| **调用方式** | 服务端 API 路由（Next.js Route Handler），前端不直接暴露 API Key |

## 二、Prompt 设计思路

### 2.1 系统提示（System Prompt）

```
你是物流出库单解析专家。根据文件内容生成JSON规则配置。

文件格式: 每行 "行N: 值1 | 值2 | 值3 | ..."
sourceField 取纯净列名（不含"行N: "前缀）

返回JSON结构: {...}

可选targetField: 外部编码,收货门店,收件人姓名,收件人电话,收件人地址,
                  SKU物品编码,SKU物品名称,SKU发货数量,SKU规格型号,备注

补充检测: footerExtraction(尾部信息), aggregation(跨行聚合),
          matrixTranspose(矩阵转置), multiSheet(多Sheet),
          cardBoundary(卡片式), pdfConfig(PDF配置)

只返回JSON，无其他文字。
```

**设计原则：**
1. **角色明确**：定位为"物流出库单解析专家"，限定领域
2. **输入格式说明**：明确告知每行的 `行N: 列1 | 列2` 格式，指示提取纯净列名
3. **输出结构约束**：给出目标字段枚举（10个字段），防止 AI 编造字段名
4. **精简高效**：去掉冗余说明，缩短 token 消耗 → 加快响应
5. **只返回 JSON**：避免 `markdown` 代码块包裹，减少后处理

### 2.2 用户提示（User Prompt）

```
文件名: {fileName} ({fileType})
文件内容（前40行，格式: 行N: 列1 | 列2 | ...）:
{fileContent.substring(0, 2000)}

请返回JSON规则，识别: 表头行号、列映射(SKU编码/名称/数量=必填)、
尾部收货信息、跨行聚合、矩阵转置、多Sheet。
```

**设计原则：**
1. **有限上下文**：只发送前40行/2000字符，减少 token 消耗
2. **关键提示**：明确标记 SKU 编码/名称/数量为必填字段
3. **检测提示**：列出所有需检测的特殊结构（尾部信息、聚合、转置）

### 2.3 参数配置

```typescript
{
  model: "mimo-v2.5-pro",
  temperature: 0.1,    // 极低温度 → 确定性输出，避免列名变异
  max_tokens: 2000,    // 限制输出长度，加速响应
}
```

### 2.4 降级策略

当 AI 服务不可用时，自动降级到**本地启发式分析**：
- 检测表头行（关键词：编码、名称、数量）
- 列名模糊匹配 → 自动映射到10个标准字段
- 检测特殊结构：配送单号 → 跨行聚合；门店列头 → 矩阵转置
- 检测文件特征：PDF 尾部收货信息、Word 分隔符文本解析

## 三、API Key 配置方式

### 3.1 配置层级

```
用户 ←→ 前端 (浏览器) ←→ Next.js API Route (服务端) ←→ AI 大模型
                              ↑ 仅此处有 API Key
                              ↓ 环境变量注入
                           process.env.AI_API_KEY
```

### 3.2 环境变量设置

**本地开发**：`.env.local` 文件（不提交 Git）

```bash
AI_API_BASE_URL=https://token-plan-cn.xiaomimimo.com/v1
AI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx
AI_MODEL=mimo-v2.5-pro
```

**Vercel 生产部署**：Vercel Dashboard → Project → Settings → Environment Variables

| Key | Value | Environment |
|-----|-------|-------------|
| `AI_API_BASE_URL` | `https://token-plan-cn.xiaomimimo.com/v1` | Production, Preview |
| `AI_API_KEY` | `sk-...` (encrypted) | Production, Preview |
| `AI_MODEL` | `mimo-v2.5-pro` | Production, Preview |

### 3.3 服务端读取

```typescript
// src/lib/ai/ai-service.ts
const API_BASE = process.env.AI_API_BASE_URL || "https://api.deepseek.com/v1";
const API_KEY = process.env.AI_API_KEY || "";
const AI_MODEL = process.env.AI_MODEL || "mimo-v2.5-pro";
```

**安全设计：**
- 前端代码中**不包含** `NEXT_PUBLIC_` 前缀的 API Key
- 所有 AI 调用通过 `/api/ai/analyze` 服务端路由代理
- API Key 仅在服务端 `process.env` 中存在，浏览器不可见

### 3.4 调用链路

```
1. 前端 upload/page.tsx → fetch("/api/ai/analyze", { fileContent, fileName, fileType })
2. API Route → ai-service.ts → analyzeFileAndGenerateRule()
3. ai-service → fetch("https://token-plan-cn.xiaomimimo.com/v1/chat/completions", { Authorization: "Bearer " + API_KEY })
4. 返回 rule JSON → 前端展示确认 → 保存规则 → 执行解析
```

### 3.5 超时保护

```typescript
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), 15000); // 15秒超时
```

超时后自动降级到本地启发式分析，确保用户体验不受阻。
