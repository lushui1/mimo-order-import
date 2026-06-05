# 考点文档：AI 大模型调用说明

> 对应考试提交要求第三项：说明使用的模型、Prompt 设计思路、API Key 配置方式

---

## 一、使用的模型

| 项目 | 详情 |
|------|------|
| **模型名称** | `mimo-v2.5-pro` |
| **模型提供方** | TokenPlan / 小米 |
| **API 端点** | `https://token-plan-cn.xiaomimimo.com/v1/chat/completions` |
| **调用方式** | OpenAI 兼容 Chat Completions API |
| **环境** | 仅服务端（Next.js API Route），前端不感知 |

---

## 二、Prompt 设计思路

### 2.1 核心设计原则

考试核心考点要求：**AI 生成解析规则，而非直接解析数据**。

这意味着 Prompt 的目标不是"AI 直接输出下单数据"，而是"AI 输出一套可复用的规则配置"，再由规则引擎根据规则执行解析。这样：
- 规则可人工审核、修改、复用
- 同一种格式只需分析一次
- 代码零改动适配新格式

### 2.2 System Prompt（系统提示）

```
你是物流出库单解析专家。根据文件内容生成JSON规则配置。

文件格式: 每行 "行N: 值1 | 值2 | 值3 | ..."
sourceField 取纯净列名（不含"行N: "前缀）

返回JSON结构:
{"header":{"skipRows":数字,"headerRow":数字},"columnMappings":[{"sourceField":"列名","targetField":"目标","isRequired":bool,"transform":"toNumber"(可选),"aiConfidence":0.8}]}

可选targetField: 外部编码,收货门店,收件人姓名,收件人电话,收件人地址,SKU物品编码,SKU物品名称,SKU发货数量,SKU规格型号,备注

补充检测(可选): footerExtraction(尾部信息), aggregation(跨行聚合), matrixTranspose(矩阵转置), multiSheet(多Sheet), cardBoundary(卡片式), pdfConfig(PDF配置)

只返回JSON，无其他文字。
```

**设计要点：**
1. **明确角色**：定义为"物流出库单解析专家"，限定领域
2. **明确输出格式**：要求只返回 JSON，避免额外对话
3. **限定字段空间**：`targetField` 枚举 10 个预定义字段，防止 AI 创造不存在的字段
4. **列名净化规则**：教授 AI 去除 `行N: ` 前缀
5. **覆盖复杂场景**：补充检测项覆盖尾部提取、跨行聚合、矩阵转置、多Sheet、卡片式、PDF 配置等 9 种 demo 格式

### 2.3 User Prompt（用户提示）

```
文件名: {fileName} ({fileType})
文件内容（前40行，格式: 行N: 列1 | 列2 | ...）:
{fileContent.substring(0, 2000)}

请返回JSON规则，识别: 表头行号、列映射(SKU编码/名称/数量=必填)、尾部收货信息、跨行聚合、矩阵转置、多Sheet。
```

**设计要点：**
1. **控制 Token 用量**：仅发送前 40 行（约 2000 字符），减少 API 延迟
2. **格式标注**：明确告知 AI 内容格式（`行N: 列1 | 列2 | ...`），避免格式误读
3. **简洁指令**：一句话明确识别要点

### 2.4 降级机制

当 AI API 不可用（无 Key、超时、报错）时，自动降级到 `localAnalyze()` 本地启发式分析：
- 基于列名模糊匹配（exact → contains → reverse 三级）
- 直接生成规则配置（无需 AI）
- 保证系统在无网络/无 API 环境下仍可工作

### 2.5 其他 AI 调用场景

| 场景 | 调用时机 | Prompt 策略 |
|------|---------|------------|
| 规则生成 | 上传新文件 → 新建规则 | 上述 System + User Prompt |
| 规则试解析 | 保存规则前预览 | 无需 AI，规则引擎直接执行 |

---

## 三、API Key 配置方式

### 3.1 安全设计：前后端分离

```
┌─────────────┐     HTTP POST      ┌──────────────────┐     HTTPS       ┌─────────────┐
│   前端浏览器  │ ─────────────────→ │  Next.js API Route │ ─────────────→ │  AI 大模型   │
│  (无 API Key) │                    │  /api/ai/analyze  │                │  mimo-v2.5   │
│              │ ←───────────────── │  (持有 API Key)    │ ←───────────── │             │
└─────────────┘     JSON 响应        └──────────────────┘    JSON 响应     └─────────────┘
```

- **API Key 只存在于服务端**（Vercel 环境变量），前端代码中没有任何 `NEXT_PUBLIC_` 前缀的 AI 相关变量
- 所有 AI 调用通过 Next.js API Route（`/api/ai/analyze`）转发
- 前端只需要 `fetch('/api/ai/analyze', { body })` 即可使用 AI 能力

### 3.2 环境变量配置

在 Vercel Dashboard → Settings → Environment Variables 中配置：

| 环境变量 | 说明 | 示例值 |
|---------|------|-------|
| `AI_API_KEY` | 大模型 API 密钥 | `sk-xxx...` |
| `AI_API_BASE_URL` | API 基础地址 | `https://token-plan-cn.xiaomimimo.com/v1` |
| `AI_MODEL` | 模型标识 | `mimo-v2.5-pro` |

所有变量类型设为 **Encrypted**，仅在生产/预览/开发环境生效。

### 3.3 代码中的使用

```typescript
// src/lib/ai/ai-service.ts（服务端专用，不会打包到客户端）

const API_KEY = process.env.AI_API_KEY || "";        // 不暴露
const API_BASE = process.env.AI_API_BASE_URL || "";
const AI_MODEL = process.env.AI_MODEL || "mimo-v2.5-pro";

// 15 秒超时保护
const controller = new AbortController();
setTimeout(() => controller.abort(), 15000);

const response = await fetch(`${API_BASE}/chat/completions`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${API_KEY}`,
  },
  body: JSON.stringify({
    model: AI_MODEL,
    messages: [...],
    temperature: 0.1,
    max_tokens: 2000,
  }),
  signal: controller.signal,
});
```

---

## 四、提交汇总

| 提交项 | 内容 |
|--------|------|
| **在线地址** | https://20260605135655.vercel.app |
| **源码仓库** | https://github.com/lushui1/mimo-order-import |
| **大模型调用说明** | 本文档 |
