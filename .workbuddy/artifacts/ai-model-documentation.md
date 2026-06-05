# 万能导入 V2 — 大模型调用说明

## 一、使用的模型

| 配置项 | 值 |
|--------|-----|
| **模型名称** | `mimo-v2.5-pro` |
| **模型提供商** | 小米 TokenPlan |
| **API Base URL** | `https://token-plan-cn.xiaomimimo.com/v1` |
| **API 协议** | OpenAI-compatible Chat Completions API |
| **调用方式** | `POST {baseUrl}/chat/completions` |
| **温度参数** | `temperature: 0.1`（低温度确保规则生成的稳定性和一致性） |
| **最大 Token** | `max_tokens: 2000` |
| **超时保护** | 15 秒 AbortController 超时，超时自动降级到本地分析 |

### 为什么选择 mimo-v2.5-pro

- **中文理解能力强**：小米 TokenPlan 模型对中文物流单据的语义识别准确度高，能准确理解"配送单号""收货门店""物品编码"等中文物流术语。
- **JSON 输出稳定**：低温度（0.1）确保每次对相同文件结构的分析结果高度一致，不会因为随机性导致规则漂移。
- **响应速度快**：平均响应时间 3-8 秒，适合批量文件分析场景。

---

## 二、Prompt 设计思路

### 2.1 双层 Prompt 架构

```
┌────────────────────────────────────────────┐
│           System Prompt（固定）              │
│  定义角色、输出格式、字段映射规则、           │
│  高级结构类型说明                            │
├────────────────────────────────────────────┤
│           User Prompt（动态）                │
│  文件名 + 文件类型 + 前40行内容              │
└────────────────────────────────────────────┘
```

### 2.2 System Prompt 设计

System Prompt 包含以下核心要素：

**（1）角色定义**
```
你是物流出库单解析规则专家。分析文件内容，输出JSON解析规则配置。
```

**（2）输入格式描述**
```
文件格式说明：每行格式为"行N: 值1 | 值2 | 值3 | ..."，
多个Sheet用"--- Sheet: 名称 ---"分隔。
```
这是文件预处理后的统一格式——无论原始是 Excel/PDF/Word，都先转换为带行号的文本流，确保模型面对的是统一格式。

**（3）必选/可选字段映射**
```
必选字段 targetField 映射：
- SKU物品编码（必填）、SKU物品名称（必填）、SKU发货数量（必填，toNumber）
- SKU规格型号、外部编码（配送单号/订单号）、收货门店
- 收件人姓名、收件人电话、收件人地址
- 备注
```

**（4）7 种高级结构类型说明**
```
1. footerExtraction  — 收货信息在表格底部独立行
2. aggregation       — 多行共享收货人信息，按配送单号分组
3. matrixTranspose   — 门店名/日期作为列头，需转置
4. multiSheet        — 多个Sheet各有独立数据
5. cardBoundary      — 非标准表格，以特殊标记分隔记录
6. pdfConfig         — PDF文件，含表格+尾部信息
7. textParse         — Word纯文本，用正则提取
```

**设计意图**：通过明确列出 7 种高级结构类型，引导模型主动识别文件中的复杂布局，而非只做简单的行列映射。每种类型都附带具体参数名和用途，减少模型的幻觉。

**（5）输出约束**
```
只输出JSON，不含任何其他文字。
```

### 2.3 User Prompt 设计

```
文件名: {fileName} ({fileType})
文件内容（前40行，格式: 行N: 列1 | 列2 | ...）:
{fileContent.substring(0, 2000)}
```

**设计考量**：
- **截断 2000 字符**：取前 40 行足够覆盖表头和前几条数据，同时控制 Token 消耗
- **保留行号前缀**："行N: " 前缀让模型能准确报告表头行号，而非猜测
- **保留管分隔符**：`|` 分隔符保留原始结构，让模型能区分数值列和文本列

### 2.4 降级策略

当 AI 服务不可用时（无 API Key、超时、返回异常），自动降级到 `localAnalyze()` 本地启发式分析：

```
AI 调用 → 成功 → 返回 AI 生成的规则
       → 失败 → 本地启发式分析（基于列关键词 + 结构特征检测）
```

本地分析同样输出完整的 `ParseRule` 结构，包含列映射、聚合检测、矩阵转置检测、多 Sheet 检测等，确保用户在无网络环境下也能使用基本功能。

---

## 三、API Key 配置方式

### 3.1 安全设计原则

**API Key 绝不暴露给前端。**

所有 AI 调用均通过 Next.js API 路由在服务端完成：

```
前端(浏览器)                服务端(Next.js)               AI 服务
    │                           │                           │
    │  POST /api/ai/analyze     │                           │
    │  {fileContent, fileName}  │                           │
    │ ─────────────────────────>│                           │
    │                           │  Bearer {API_KEY}         │
    │                           │  /chat/completions        │
    │                           │ ─────────────────────────>│
    │                           │                           │
    │                           │  <── JSON 规则 ──────────│
    │                           │                           │
    │  <── {success, rule} ────│                           │
    │                           │                           │
```

### 3.2 本地开发配置

文件：`.env.local`（不提交到 Git，已在 `.gitignore` 中）

```bash
# AI 大模型配置（TokenPlan / 小米）
AI_API_BASE_URL=https://token-plan-cn.xiaomimimo.com/v1
AI_API_KEY=tp-coaexsbmnyoe8zdvdqruymohn4o0mcli05rr7ddlkw9ekh7c
AI_MODEL=mimo-v2.5-pro

# 兼容旧版变量名
AI_API_URL=https://token-plan-cn.xiaomimimo.com/v1
NEXT_PUBLIC_AI_API_URL=https://token-plan-cn.xiaomimimo.com/v1
```

**注意事项**：
- `AI_API_KEY` 不使用 `NEXT_PUBLIC_` 前缀 → 不会被 Next.js 打包到客户端 JS
- `AI_API_BASE_URL` 虽然不带 `NEXT_PUBLIC_`，但 base URL 本身不含敏感信息，暴露也无安全风险
- `NEXT_PUBLIC_AI_API_URL` 仅用于兼容旧版参考，实际代码优先读取 `AI_API_BASE_URL`

### 3.3 生产环境配置（Vercel）

在 Vercel Dashboard → 项目设置 → Environment Variables 中添加：

| Key | Value |
|-----|-------|
| `AI_API_BASE_URL` | `https://token-plan-cn.xiaomimimo.com/v1` |
| `AI_API_KEY` | `tp-coaexsbmnyoe8zdvdqruymohn4o0mcli05rr7ddlkw9ekh7c` |
| `AI_MODEL` | `mimo-v2.5-pro` |

Vercel 环境变量会在部署时注入到服务端运行时，前端完全不可见。

### 3.4 API Key 获取方式

| 步骤 | 说明 |
|------|------|
| 1. 注册 | 访问 https://token-plan-cn.xiaomimimo.com 注册小米 TokenPlan 账号 |
| 2. 创建 API Key | 控制台 → API 密钥管理 → 创建新密钥 |
| 3. 配置限额 | 建议设置月度调用限额防止超支 |
| 4. 填入环境变量 | 将密钥填入 `.env.local`（本地）或 Vercel Environment Variables（生产） |

### 3.5 权限控制

```
API路由: /api/ai/analyze
方法: POST
鉴权: 无需用户登录（内部工具）
速率限制: 建议 nginx/vercel.json 配置 10req/min 防止滥用
```

### 3.6 环境变量读取优先级

```typescript
// ai-service.ts 中的读取逻辑（优先级从上到下）

// 模型名
AI_MODEL || "mimo-v2.5-pro"  // env → 默认值

// API Base URL  
AI_API_BASE_URL              // 第一优先（私有变量）
|| AI_API_URL                // 第二优先（旧版兼容）
|| NEXT_PUBLIC_AI_API_URL    // 第三优先（公开兼容）
|| "https://api.deepseek.com/v1" // 最终默认值（不会被使用）

// API Key
AI_API_KEY                   // 第一优先（私有变量）
|| NEXT_PUBLIC_AI_API_KEY    // 第二优先（公开兼容）
|| ""                         // 空 → 触发本地分析降级
```

---

## 四、完整调用流程

```
1. 用户上传文件（Excel/PDF/Word）
      │
2. 前端调用 POST /api/parse/preview
   将文件转换为文本流（rawFileToText）
      │
3. 前端调用 POST /api/ai/analyze
   传入 {fileContent, fileName, fileType}
      │
4. 服务端 api/ai/analyze/route.ts
   ├─ 截断内容至 5000 字符
   └─ 调用 analyzeFileAndGenerateRule()
          │
5. ai-service.ts
   ├─ 有 API Key？
   │   ├─ YES → 构建 Prompt → 调用 AI API
   │   │           │
   │   │           ├─ 成功 → 解析 JSON 响应 → 返回规则
   │   │           └─ 失败/超时 → 降级
   │   └─ NO  → 降级
   │
   └─ 降级: localAnalyze()
       基于列关键词 + 结构特征检测生成规则
          │
6. 返回 ParseRule 给前端
      │
7. 前端展示规则配置界面
   用户确认/微调 → 执行解析 → 生成订单列表
```

---

## 五、Prompt 设计亮点总结

| 设计点 | 目的 | 效果 |
|--------|------|------|
| 统一文本流格式 | 抹平 Excel/PDF/Word 差异 | 模型面对同一接口，减少格式特定处理 |
| 保留行号前缀 | 让模型精确定位表头行 | 避免偏移误差 |
| 7 种高级结构枚举 | 引导模型识别复杂布局 | 支持聚合/转置/多Sheet/卡片/PDF/Word 等多种场景 |
| 低温度 0.1 | 确保规则输出稳定 | 同样的文件每次产生相同规则 |
| 15 秒超时+降级 | 保证系统可用性 | AI 不可用时仍能通过本地分析工作 |
| System/User 双层 Prompt | 分离通用知识与具体任务 | System Prompt 可复用，User Prompt 轻量 |
| JSON-only 输出约束 | 避免额外文字干扰解析 | 返回可直接 JSON.parse 的纯净结构 |
