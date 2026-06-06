# 万能导入 V2 — 考试提交材料

## 一、在线地址（Vercel 部署）

**部署 URL**: https://20260605135655.vercel.app

- 框架：Next.js 14 (App Router)
- 部署平台：Vercel
- 数据库：Vercel Postgres
- 区域：iad1 (美国东部)
- AI 分析 API 超时：60 秒
- 规则/订单 API 超时：30 秒

## 二、源码仓库

**GitHub**: https://github.com/lushui1/mimo-order-import

- 分支：main
- 技术栈：Next.js 14 + TypeScript + Vercel Postgres
- UI 风格：鲸天系统风格（主色 #0fc6c2）

## 三、大模型调用说明

### 3.1 使用的模型

| 项目 | 说明 |
|------|------|
| 模型名称 | `mimo-v2.5`（TokenPlan/小米） |
| API 端点 | `https://token-plan-cn.xiaomimimo.com/v1`（可配置） |
| 模型特性 | Reasoning 模型，首次响应延迟 15-20 秒 |
| 调用方式 | OpenAI 兼容 Chat Completions API（流式 SSE） |
| 温度 | 0.05（追求确定性输出） |
| max_tokens | 8000 |

### 3.2 API Key 配置方式

API Key 通过**服务端环境变量**配置，不暴露给前端：

```
# 环境变量（优先级从高到低）
AI_API_KEY=<your-api-key>          # 主配置
AI_API_BASE_URL=<base-url>         # API 基础 URL（默认 https://api.deepseek.com/v1）
AI_MODEL=mimo-v2.5                  # 模型名称（默认 mimo-v2.5）
```

**安全设计**：
- 环境变量名不含 `NEXT_PUBLIC_` 前缀，确保仅在服务端 API Route 中可访问
- 前端无法通过 `process.env` 读取到这些值
- AI 调用封装在 `src/lib/ai/ai-service.ts` 中，仅在服务端 API Route (`/api/ai/analyze`) 中使用

**Vercel 配置**：在 Vercel Dashboard → Settings → Environment Variables 中添加上述环境变量。

### 3.3 Prompt 设计思路

#### 策略：本地分析为主、AI 可选增强

由于 mimo-v2.5 是 reasoning 模型，首次响应需要 15-20 秒，因此采用**分层策略**：

1. **第一层：本地启发式分析**（< 100ms，覆盖率 > 90%）
   - 扫描文件文本，识别表头行位置和列名
   - 通过关键词匹配建立列映射（编码→SKU物品编码，数量→SKU发货数量等）
   - 对 PDF 无表头行的情况，通过数据值特征推断列含义（ZBWP格式→编码，递增序列→序号等）
   - 如果本地分析结果 >= 3 个映射，直接返回，不调用 AI

2. **第二层：AI 审核修正**（仅在本地分析不足时触发）
   - 将本地分析结果和文件预览发给 AI
   - AI 作为"审核员"角色，修正本地分析的错误

#### System Prompt

```
你是物流出库单规则审核员。用户已用本地算法生成规则，你只需修正错误。
输出纯JSON，格式：{"header":{"skipRows":N,"headerRow":N},"columnMappings":[{"sourceField":"列名","targetField":"标准字段","isRequired":bool,"transform":"toNumber"}],"aggregation":{"enabled":true,"groupByField":"外部编码","sharedFields":["收件人姓名","收件人电话","收件人地址"]}}
标准字段：SKU物品编码,SKU物品名称,SKU发货数量,SKU规格型号,外部编码,收货门店,收件人姓名,收件人电话,收件人地址,备注
```

**设计要点**：
- 角色限定为"审核员"而非"从零分析"，降低模型推理负担
- 输出约束为纯 JSON，便于解析
- 提供标准字段列表，确保映射一致性
- 内置聚合规则模板（按外部编码分组）

#### User Prompt

```
文件:配送单.xlsx(xlsx)
行0: 单据编号 | 配送日期 | ...
行1: SKU编码 | SKU名称 | 数量 | ...

本地规则:{"header":{"skipRows":0,"headerRow":0},"columnMappings":[...]}

修正此规则。仅输出JSON。
```

**设计要点**：
- 只发送文件前 600 字符（表头 + 少量数据），减少 token 消耗
- 附上本地分析结果，让 AI 只需修正而非从头分析
- 明确指令"仅输出JSON"，避免冗余文本

#### AI 响应处理

- 流式读取 SSE 数据，实时拼接完整响应
- JSON 提取：支持 Markdown 代码块、花括号平衡匹配、贪婪匹配三重策略
- 结果验证：至少 3 个映射、包含必填字段（SKU物品编码/名称/数量）
- 失败回退：AI 调用失败或结果无效时，自动回退到本地分析结果
