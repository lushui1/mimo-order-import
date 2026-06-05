"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { getRules, saveRule, generateId, setCurrentOrders, getCurrentOrders, syncRulesFromServer } from "@/lib/store";
import { parseFile, rawFileToText } from "@/lib/rule-engine/file-parser";
import { executeRule } from "@/lib/rule-engine/rule-executor";
import { getDefaultRules } from "@/lib/rule-engine/presets";
import type { ParseRule, RawFile, ParsedOrder, ColumnMapping } from "@/lib/types";
import { useToast } from "@/components/ToastProvider";

type Step = "upload" | "rule-select" | "ai-analyze" | "parsing" | "done";

export default function UploadPage() {
  const [step, setStep] = useState<Step>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [rawFile, setRawFile] = useState<RawFile | null>(null);
  const [selectedRule, setSelectedRule] = useState<ParseRule | null>(null);
  const [rules, setRules] = useState<ParseRule[]>([]);
  const [aiRule, setAiRule] = useState<Partial<ParseRule> | null>(null);
  const [progress, setProgress] = useState({ current: 0, total: 100, text: "" });
  const [dragActive, setDragActive] = useState(false);
  const [showAiResult, setShowAiResult] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const toast = useToast();

  const refreshRules = useCallback(async () => {
    const saved = getRules();
    if (saved.length === 0) {
      const presets = getDefaultRules();
      presets.forEach((r) => saveRule(r));
      const fresh = getRules();
      setRules(fresh);
    } else {
      // 同步服务端规则并合并
      const merged = await syncRulesFromServer(saved);
      setRules(merged);
    }
  }, []);

  // Auto-load presets if no rules exist
  useEffect(() => {
    refreshRules();
  }, [refreshRules]);

  const handleFileDrop = useCallback(async (f: File) => {
    // Validate
    const validTypes = [".xlsx", ".xls", ".docx", ".pdf"];
    const ext = "." + f.name.split(".").pop()?.toLowerCase();
    if (!validTypes.includes(ext)) {
      toast.showToast(`不支持的文件格式: ${ext}，支持 Excel/Word/PDF`, "error");
      return;
    }

    setFile(f);
    setProgress({ current: 0, total: 100, text: "正在读取文件..." });
    setStep("upload");

    try {
      const buffer = await f.arrayBuffer();
      console.log(`File size: ${buffer.byteLength} bytes, type: ${f.type}`);
      const parsed = await parseFile(f, buffer);
      console.log(`Parsed: ${parsed.fileType}, ${parsed.sheets.length} sheets`);
      setRawFile(parsed);
      setProgress({ current: 50, total: 100, text: `文件读取完成 (${parsed.sheets[0]?.rows.length || 0}行)` });

      // 手动选择规则 — 不做自动匹配
      await refreshRules();
      const freshRules = getRules();
      setRules(freshRules);
      setSelectedRule(null);
      setStep("rule-select");
      setProgress({ current: 100, total: 100, text: "就绪 — 请选择或创建解析规则" });
      toast.showToast(`已读取: ${f.name}，请选择解析规则或新建`, "success");
    } catch (err: any) {
      console.error("Parse error:", err);
      toast.showToast(`文件读取失败: ${err.message}`, "error");
    }
  }, [refreshRules, toast]);

  const handleAiAnalyze = async () => {
    if (!rawFile || !file) return;
    setStep("ai-analyze");
    setProgress({ current: 10, total: 100, text: "AI 正在分析文件结构..." });

    try {
      const fileText = rawFileToText(rawFile, 40); // 减少到40行加速AI分析
      // 通过服务端 API 调用 AI，避免暴露 API Key
      const response = await fetch("/api/ai/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileContent: fileText,
          fileName: file.name,
          fileType: rawFile.fileType,
        }),
      });
      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || `AI 分析失败 (${response.status})`);
      }
      const data = await response.json();
      const rule = data.rule;

      // 安全检查：如果规则没有列映射，说明分析失败
      if (!rule.columnMappings || rule.columnMappings.length === 0) {
        throw new Error("AI 未生成有效的列映射，请尝试手动创建规则");
      }

      setAiRule(rule);
      setShowAiResult(true);

      // 如果是 fallback 规则，提示用户
      if ((rule as any)._fallback) {
        setProgress({ current: 100, total: 100, text: "本地分析完成（AI 未返回有效规则）" });
        toast.showToast(`AI 分析未返回有效规则，已使用本地启发式分析替代`, "info");
      } else {
        setProgress({ current: 100, total: 100, text: "AI 分析完成" });
        toast.showToast("AI 已生成推荐规则，请确认", "info");
      }
    } catch (err: any) {
      toast.showToast(`AI 分析失败: ${err.message}`, "error");
      setStep("rule-select");
    }
  };

  const confirmAiRule = () => {
    if (!aiRule) return;

    // 安全检查：拒绝保存空的列映射
    if (!aiRule.columnMappings || aiRule.columnMappings.length === 0) {
      toast.showToast("规则列映射为空，无法保存。请重新进行 AI 分析或手动创建规则", "error");
      return;
    }

    const isFallback = (aiRule as any)._fallback;
    const newRule: ParseRule = {
      id: generateId(),
      name: `${file?.name?.split(".")[0] || "新规则"} - AI生成规则`,
      description: isFallback
        ? `本地启发式分析 · 基于 ${file?.name || "未知文件"}（AI 未返回有效规则）`
        : `AI 自动生成 · 基于 ${file?.name || "未知文件"}`,
      fileType: rawFile?.fileType || "excel",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      aiGenerated: true,
      header: aiRule.header || { skipRows: 0, headerRow: 0 },
      columnMappings: aiRule.columnMappings || [],
      footerExtraction: aiRule.footerExtraction,
      aggregation: aiRule.aggregation,
      matrixTranspose: aiRule.matrixTranspose,
      multiSheet: aiRule.multiSheet,
      cardBoundary: aiRule.cardBoundary,
      pdfConfig: aiRule.pdfConfig,
      textParse: aiRule.textParse,
    };
    const result = saveRule(newRule);
    if (!result.success) {
      toast.showToast(result.error || "保存失败", "error");
      setShowAiResult(false);
      setStep("rule-select");
      return;
    }
    setSelectedRule(newRule);
    setShowAiResult(false);
    refreshRules();
    toast.showToast(isFallback ? "本地分析规则已保存并选中" : "AI 规则已保存并选中", "success");
    setStep("rule-select");
  };

  const executeParsing = async () => {
    if (!rawFile || !selectedRule) return;
    setStep("parsing");
    setProgress({ current: 10, total: 100, text: "正在执行解析..." });

    try {
      const orders = await executeRule(selectedRule, rawFile);
      console.log("ExecuteRule result:", orders.length, "orders, first:", orders[0]);

      if (orders.length === 0) {
        const ruleMappings = selectedRule.columnMappings?.length || 0;
        const ruleHeaderRow = selectedRule.header?.headerRow ?? 0;
        const hint = ruleMappings === 0
          ? "规则列映射为空，请删除此规则后重新进行 AI 分析"
          : `解析结果为空（规则映射 ${ruleMappings} 列，表头行 ${ruleHeaderRow}），请检查：① 表头行号是否正确 ② 列名是否与文件匹配 ③ 尝试重新 AI 分析`;
        toast.showToast(hint, "error");
        setStep("rule-select");
        return;
      }

      setProgress({ current: 80, total: 100, text: `解析完成，共 ${orders.length} 条记录` });
      
      setCurrentOrders(orders);
      
      // Verify data was saved
      const saved = getCurrentOrders();
      console.log("Saved orders count:", saved.length);
      
      setProgress({ current: 100, total: 100, text: `就绪 - ${orders.length} 条运单` });
      
      toast.showToast(`解析完成，共 ${orders.length} 条运单`, "success");
      setStep("done");
    } catch (err: any) {
      console.error("Parse error:", err);
      toast.showToast(`解析失败: ${err.message}`, "error");
      setStep("rule-select");
    }
  };

  // 直接传入 rule 执行解析（供自动匹配后调用，避免 state 异步问题）
  const executeParsingWithRule = async (rule: ParseRule, rf: RawFile) => {
    if (!rf || !rule) return;
    setStep("parsing");
    setProgress({ current: 10, total: 100, text: "正在执行解析..." });

    try {
      const orders = await executeRule(rule, rf);
      console.log("executeParsingWithRule result:", orders.length, "orders");

      if (orders.length === 0) {
        toast.showToast("解析结果为空，请检查规则配置是否匹配文件格式", "error");
        setStep("rule-select");
        return;
      }

      setProgress({ current: 80, total: 100, text: `解析完成，共 ${orders.length} 条记录` });
      setCurrentOrders(orders);
      const saved = getCurrentOrders();
      console.log("Saved orders count:", saved.length);

      setProgress({ current: 100, total: 100, text: `就绪 - ${orders.length} 条运单` });
      toast.showToast(`解析完成，共 ${orders.length} 条运单`, "success");
      setStep("done");
    } catch (err: any) {
      console.error("Parse error:", err);
      toast.showToast(`解析失败: ${err.message}`, "error");
      setStep("rule-select");
    }
  };

  const goToPreview = () => {
    router.push("/preview");
  };

  return (
    <div className="fade-in" style={{ maxWidth: 800, margin: "0 auto" }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700 }}>导入数据</h1>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4 }}>
          上传出库单文件 → 选择/创建解析规则 → 预览数据
        </p>
      </div>

      {/* Step Progress */}
      <div style={{ display: "flex", gap: 0, marginBottom: 24, alignItems: "center" }}>
        {[
          { id: "upload", label: "上传文件" },
          { id: "rule-select", label: "选择规则" },
          { id: "parsing", label: "解析执行" },
          { id: "done", label: "完成" },
        ].map((s, i) => (
          <div key={s.id} style={{ flex: 1, display: "flex", alignItems: "center" }}>
            <div style={{ textAlign: "center", flex: 1 }}>
              <div style={{
                width: 32, height: 32, borderRadius: "50%",
                background: step === s.id || (["parsing", "done"].includes(step) && ["upload", "rule-select", "parsing", "done"].indexOf(s.id) <= ["upload", "rule-select", "parsing", "done"].indexOf(step)) ? "var(--primary)" : "var(--border)",
                color: step === s.id || (["parsing", "done"].includes(step) && ["upload", "rule-select", "parsing", "done"].indexOf(s.id) <= ["upload", "rule-select", "parsing", "done"].indexOf(step)) ? "white" : "var(--text-secondary)",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 14, fontWeight: 600, margin: "0 auto 6px",
                transition: "all 0.3s"
              }}>
                {["parsing", "done"].includes(step) && ["upload", "rule-select"].includes(s.id) ? "✓" : i + 1}
              </div>
              <div style={{ fontSize: 12, color: step === s.id ? "var(--primary)" : "var(--text-secondary)", fontWeight: step === s.id ? 600 : 400 }}>
                {s.label}
              </div>
            </div>
            {i < 3 && <div style={{ flex: 1, height: 2, background: step === "done" || (step === "parsing" && s.id === "parsing") ? "var(--primary)" : "var(--border)" }} />}
          </div>
        ))}
      </div>

      {/* Step: Upload */}
      {step === "upload" && (
        <div
          className={`dropzone ${dragActive ? "active" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
          onDragLeave={() => setDragActive(false)}
          onDrop={(e) => { e.preventDefault(); setDragActive(false); handleFileDrop(e.dataTransfer.files[0]); }}
          onClick={() => inputRef.current?.click()}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".xlsx,.xls,.docx,.pdf"
            style={{ display: "none" }}
            onChange={(e) => e.target.files?.[0] && handleFileDrop(e.target.files[0])}
          />
          <div style={{ fontSize: 48, marginBottom: 12 }}>📤</div>
          <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>拖拽文件到此处，或点击上传</h3>
          <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>
            支持 Excel (.xlsx/.xls)、Word (.docx)、PDF 格式
          </p>
        </div>
      )}

      {/* Step: Rule Selection */}
      {step === "rule-select" && (
        <div className="card">
          <div className="card-header">
            <h3 style={{ fontSize: 15, fontWeight: 600 }}>
              {file?.name || ""}
            </h3>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-secondary btn-sm" onClick={() => { setStep("upload"); setFile(null); }}>
                重新上传
              </button>
              <button className="btn btn-primary btn-sm" onClick={handleAiAnalyze}>
                🤖 AI 智能分析
              </button>
            </div>
          </div>
          <div className="card-body">
            <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 12 }}>
              选择已有解析规则，或点击"AI 智能分析"让系统自动生成规则
            </p>
            {rules.length === 0 ? (
              <div className="empty-state" style={{ padding: 30 }}>
                <p>暂无可用规则</p>
                <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={handleAiAnalyze}>
                  🤖 让AI分析生成
                </button>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {rules.map((rule) => (
                  <div
                    key={rule.id}
                    className="card"
                    style={{
                      padding: 14,
                      cursor: "pointer",
                      border: selectedRule?.id === rule.id ? "2px solid var(--primary)" : "1px solid var(--border)",
                    }}
                    onClick={() => setSelectedRule(rule)}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div>
                        <div style={{ fontWeight: 500, fontSize: 14 }}>{rule.name}</div>
                        <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>{rule.description}</div>
                      </div>
                      <span className="badge badge-primary">{rule.fileType.toUpperCase()}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div style={{ marginTop: 16, display: "flex", justifyContent: "flex-end" }}>
              <button className="btn btn-primary" disabled={!selectedRule} onClick={executeParsing}>
                {selectedRule ? `使用 "${selectedRule.name}" 解析` : "请选择规则"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Step: AI Analyzing */}
      {step === "ai-analyze" && (
        <div className="card">
          <div className="card-body" style={{ textAlign: "center", padding: 40 }}>
            <div className="spinner" style={{ width: 32, height: 32, marginBottom: 16 }} />
            <p style={{ fontSize: 14, color: "var(--text-secondary)" }}>
              AI 正在分析文件结构...
            </p>
            {progress.current > 0 && (
              <div style={{ marginTop: 16, maxWidth: 400, margin: "16px auto 0" }}>
                <div className="progress-bar">
                  <div className="progress-bar-fill" style={{ width: `${progress.current}%` }} />
                </div>
                <p style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 6 }}>{progress.text}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* AI Result Modal */}
      {showAiResult && aiRule && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ maxWidth: 600 }}>
            <div className="modal-header">
              <h3 style={{ fontSize: 16, fontWeight: 600 }}>
                {(aiRule as any)._fallback ? "⚠️ 本地启发式分析规则" : "🤖 AI 推荐解析规则"}
              </h3>
              <button className="btn btn-ghost btn-sm" onClick={() => { setShowAiResult(false); setStep("rule-select"); }}>✕</button>
            </div>
            <div className="modal-body">
              {(aiRule as any)._fallback ? (
                <div style={{ padding: "10px 14px", background: "#fffbeb", border: "1px solid #fcd34d", borderRadius: 8, marginBottom: 16, fontSize: 13, color: "#92400e" }}>
                  <strong>⚠️ {(aiRule as any)._fallbackReason || "AI 未返回有效规则"}</strong>
                  <br />已使用本地启发式分析自动识别文件结构，建议核对列映射是否准确。
                </div>
              ) : (
                <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 16 }}>
                  AI 已分析文件结构并生成推荐规则，请确认后保存。标注"推测"的映射建议重点关注。
                </p>
              )}

              {/* Header Config */}
              <div style={{ marginBottom: 16 }}>
                <h4 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>表头配置</h4>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <div style={{ fontSize: 13 }}>
                    <span style={{ color: "var(--text-secondary)" }}>跳过的行数:</span> {aiRule.header?.skipRows ?? 0}
                  </div>
                  <div style={{ fontSize: 13 }}>
                    <span style={{ color: "var(--text-secondary)" }}>表头行:</span> {aiRule.header?.headerRow ?? 0}
                  </div>
                </div>
              </div>

              {/* Column Mappings */}
              <div style={{ marginBottom: 16 }}>
                <h4 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>列映射</h4>
                {(aiRule.columnMappings || []).length === 0 ? (
                  <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>无列映射配置</div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {(aiRule.columnMappings || []).map((m: ColumnMapping, i: number) => (
                      <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: "#f8fafc", borderRadius: 6, fontSize: 13 }}>
                        <span style={{ fontWeight: 500 }}>{m.sourceField || "(推测)"}</span>
                        <span style={{ color: "var(--text-secondary)" }}>→</span>
                        <span style={{ color: "var(--primary)", fontWeight: 500 }}>{m.targetField}</span>
                        {m.isRequired && <span className="badge badge-error" style={{ fontSize: 10 }}>必填</span>}
                        {m.aiConfidence && m.aiConfidence < 0.7 && <span className="badge badge-warning" style={{ fontSize: 10 }}>推测</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Advanced Config */}
              {aiRule.footerExtraction?.enabled && (
                <div style={{ marginBottom: 12, padding: "8px 12px", background: "#f0fdfb", borderRadius: 8, fontSize: 13 }}>
                  <strong>⚡ 尾部信息提取</strong> - 从表格底部提取收货信息
                </div>
              )}
              {aiRule.aggregation?.enabled && (
                <div style={{ marginBottom: 12, padding: "8px 12px", background: "#fffbeb", borderRadius: 8, fontSize: 13 }}>
                  <strong>⚡ 跨行聚合</strong> - 按"{aiRule.aggregation.groupByField}"分组，共享收货信息
                </div>
              )}
              {aiRule.matrixTranspose?.enabled && (
                <div style={{ marginBottom: 12, padding: "8px 12px", background: "#f0fdfb", borderRadius: 8, fontSize: 13 }}>
                  <strong>⚡ 矩阵转置</strong> - 列索引 {aiRule.matrixTranspose.dimensionColumns?.join(",")} 转置为行记录
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => { setShowAiResult(false); setStep("rule-select"); }}>
                不用此规则
              </button>
              <button className="btn btn-primary" onClick={confirmAiRule}>
                确认并保存规则
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Step: Parsing */}
      {step === "parsing" && (
        <div className="card">
          <div className="card-body" style={{ textAlign: "center", padding: 40 }}>
            <div className="spinner" style={{ width: 32, height: 32, marginBottom: 16 }} />
            <p style={{ fontSize: 14, color: "var(--text-secondary)", marginBottom: 16 }}>
              正在执行解析...
            </p>
            <div style={{ maxWidth: 400, margin: "0 auto" }}>
              <div className="progress-bar">
                <div className="progress-bar-fill" style={{ width: `${progress.current}%` }} />
              </div>
              <p style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 6 }}>{progress.text}</p>
            </div>
          </div>
        </div>
      )}

      {/* Step: Done */}
      {step === "done" && (
        <div className="card">
          <div className="card-body" style={{ textAlign: "center", padding: 40 }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>✅</div>
            <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>解析完成</h3>
            <p style={{ fontSize: 14, color: "var(--text-secondary)", marginBottom: 16 }}>
              {progress.text}
            </p>
            <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
              <button className="btn btn-secondary" onClick={() => { setStep("upload"); setFile(null); }}>
                导入其他文件
              </button>
              <button className="btn btn-primary" onClick={goToPreview}>
                查看数据预览 →
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
