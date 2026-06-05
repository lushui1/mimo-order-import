"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { getCurrentOrders, setCurrentOrders, generateId } from "@/lib/store";
import type { ParsedOrder, ValidationError } from "@/lib/types";
import { validatePhone, validateRequired, validateNumberPositive } from "@/lib/utils";
import { useToast } from "@/components/ToastProvider";
import * as XLSX from "xlsx";

const TARGET_FIELDS = [
  { key: "外部编码", label: "外部编码" },
  { key: "收货门店", label: "收货门店" },
  { key: "收件人姓名", label: "收件人姓名" },
  { key: "收件人电话", label: "收件人电话" },
  { key: "收件人地址", label: "收件人地址" },
  { key: "SKU物品编码", label: "SKU物品编码" },
  { key: "SKU物品名称", label: "SKU物品名称" },
  { key: "SKU发货数量", label: "SKU发货数量" },
  { key: "SKU规格型号", label: "SKU规格型号" },
  { key: "备注", label: "备注" },
];

const ROW_HEIGHT = 36;
const HEADER_HEIGHT = 40;

// 提交结果类型
interface SubmitResult {
  success: boolean;
  total: number;
  successCount: number;
  failCount: number;
  errors?: string[];
  batchId?: string;
}

export default function PreviewPage() {
  const [orders, setOrders] = useState<ParsedOrder[]>([]);
  const [editingCell, setEditingCell] = useState<{ row: number; field: string } | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(600);
  const [errors, setErrors] = useState<ValidationError[]>([]);
  const [duplicates, setDuplicates] = useState<Set<number>>(new Set());
  const tableRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const toast = useToast();

  // 提交相关状态
  const [submitting, setSubmitting] = useState(false);
  const [submitProgress, setSubmitProgress] = useState(0);
  const [submitResult, setSubmitResult] = useState<SubmitResult | null>(null);

  useEffect(() => {
    const data = getCurrentOrders();
    console.log("PreviewPage: loaded orders:", data?.length);
    if (!data || data.length === 0) {
      toast.showToast("暂无数据，请先导入或重新解析", "info");
      return;
    }
    setOrders(data);
  }, []);

  // Validation
  useEffect(() => {
    const errs: ValidationError[] = [];
    const extCodes = new Map<string, number[]>();

    orders.forEach((order, idx) => {
      // Check required fields
      if (!validateRequired(order.SKU物品编码)) {
        errs.push({ field: "SKU物品编码", message: "SKU物品编码必填", rowIndex: idx });
      }
      if (!validateRequired(order.SKU物品名称)) {
        errs.push({ field: "SKU物品名称", message: "SKU物品名称必填", rowIndex: idx });
      }
      if (!validateNumberPositive(order.SKU发货数量)) {
        errs.push({ field: "SKU发货数量", message: "发货数量必须为正数", rowIndex: idx });
      }

      // Check A/B group
      const hasStore = validateRequired(order.收货门店);
      const hasPerson = validateRequired(order.收件人姓名) && validateRequired(order.收件人电话) && validateRequired(order.收件人地址);
      if (!hasStore && !hasPerson) {
        errs.push({ field: "收货门店", message: "门店模式或收件人模式至少填一组", rowIndex: idx });
        errs.push({ field: "收件人姓名", message: "门店模式或收件人模式至少填一组", rowIndex: idx });
      }

      // Phone validation
      if (order.收件人电话 && !validatePhone(order.收件人电话)) {
        errs.push({ field: "收件人电话", message: "电话格式不正确", rowIndex: idx });
      }

      // External code duplicate detection
      if (order.外部编码) {
        const code = order.外部编码.trim();
        if (!extCodes.has(code)) extCodes.set(code, []);
        extCodes.get(code)!.push(idx);
      }
    });

    // Check duplicates
    const dupSet = new Set<number>();
    for (const [, indices] of extCodes) {
      if (indices.length > 1) {
        indices.forEach((i) => dupSet.add(i));
      }
    }
    setDuplicates(dupSet);
    setErrors(errs);
  }, [orders]);

  const getCellErrors = useCallback((rowIdx: number, field: string): string[] => {
    return errors.filter((e) => e.rowIndex === rowIdx && e.field === field).map((e) => e.message);
  }, [errors]);

  const updateCell = useCallback((rowIdx: number, field: string, value: string) => {
    setOrders((prev) => {
      const updated = [...prev];
      const order = { ...updated[rowIdx] };
      if (field === "SKU发货数量") {
        (order as any)[field] = parseFloat(value) || 0;
      } else {
        (order as any)[field] = value;
      }
      updated[rowIdx] = order;
      return updated;
    });
  }, []);

  const deleteRow = useCallback((idx: number) => {
    setOrders((prev) => prev.filter((_, i) => i !== idx));
    toast.showToast("已删除一行", "info");
  }, [toast]);

  const addRow = useCallback(() => {
    setOrders((prev) => [...prev, {
      rowIndex: prev.length,
      SKU物品编码: "",
      SKU物品名称: "",
      SKU发货数量: 0,
    }]);
  }, []);

  // 提交下单 - 调用 API 写入数据库
  const handleSubmit = useCallback(async () => {
    if (errors.length > 0) {
      toast.showToast(`有 ${errors.length} 个错误未修正，无法提交`, "error");
      return;
    }
    if (orders.length === 0) {
      toast.showToast("没有可提交的数据", "error");
      return;
    }
    if (submitting) return; // 防重复点击

    setSubmitting(true);
    setSubmitProgress(0);

    try {
      // 模拟进度条动画
      const progressInterval = setInterval(() => {
        setSubmitProgress((prev) => {
          if (prev >= 90) {
            clearInterval(progressInterval);
            return 90;
          }
          return prev + Math.random() * 15;
        });
      }, 200);

      const batchId = generateId();
      const toSubmit = orders.map((o) => ({
        ...o,
        外部编码: o.外部编码 || batchId,
      }));

      const response = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orders: toSubmit }),
      });

      clearInterval(progressInterval);
      setSubmitProgress(100);

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${response.status}`);
      }

      const result: SubmitResult = await response.json();
      setSubmitResult(result);

      // 清空当前预览数据
      setCurrentOrders([]);

      if (result.failCount === 0) {
        toast.showToast(`提交成功！共 ${result.successCount} 条运单`, "success");
      } else {
        toast.showToast(`提交完成：成功 ${result.successCount} 条，失败 ${result.failCount} 条`, "info");
      }
    } catch (e: any) {
      console.error("Submit error:", e);
      setSubmitResult({
        success: false,
        total: orders.length,
        successCount: 0,
        failCount: orders.length,
        errors: [e.message || "提交失败，请稍后重试"],
      });
      toast.showToast("提交失败: " + (e.message || "未知错误"), "error");
    } finally {
      setSubmitting(false);
    }
  }, [errors, orders, submitting, toast]);

  // 关闭结果弹窗
  const closeResult = useCallback(() => {
    setSubmitResult(null);
    if (submitResult?.success) {
      router.push("/history");
    }
  }, [submitResult, router]);

  const exportToExcel = useCallback(() => {
    const data = orders.map((o, i) => ({
      "序号": i + 1,
      "外部编码": o.外部编码 || "",
      "收货门店": o.收货门店 || "",
      "收件人姓名": o.收件人姓名 || "",
      "收件人电话": o.收件人电话 || "",
      "收件人地址": o.收件人地址 || "",
      "SKU物品编码": o.SKU物品编码,
      "SKU物品名称": o.SKU物品名称,
      "SKU发货数量": o.SKU发货数量,
      "SKU规格型号": o.SKU规格型号 || "",
      "备注": o.备注 || "",
    }));

    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "运单数据");
    XLSX.writeFile(wb, `运单数据_${new Date().toISOString().slice(0, 10)}.xlsx`);
    toast.showToast("导出成功", "success");
  }, [orders, toast]);

  // Virtual list calculations
  const visibleCount = Math.ceil(containerHeight / ROW_HEIGHT) + 5;
  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 5);
  const endIdx = Math.min(orders.length, startIdx + visibleCount);
  const visibleOrders = orders.slice(startIdx, endIdx);
  const totalHeight = orders.length * ROW_HEIGHT;

  const hasAnyError = errors.length > 0;

  // Count errors per field for summary (MUST be before early returns to keep hooks consistent)
  const errorSummary = useMemo(() => {
    const summary: Record<string, number> = {};
    errors.forEach((e) => {
      summary[e.field] = (summary[e.field] || 0) + 1;
    });
    return summary;
  }, [errors]);

  if (orders.length === 0 && !submitResult) return null;

  return (
    <div className="fade-in">
      {/* 提交进度条 */}
      {submitting && (
        <div style={{
          position: "fixed", top: 0, left: 0, right: 0, zIndex: 9999,
          background: "rgba(255,255,255,0.95)", backdropFilter: "blur(4px)",
          padding: "20px", display: "flex", flexDirection: "column", alignItems: "center", gap: 12
        }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: "var(--primary)" }}>
            正在提交订单...
          </div>
          <div style={{
            width: 400, height: 8, background: "#e5e7eb", borderRadius: 4, overflow: "hidden"
          }}>
            <div style={{
              width: `${submitProgress}%`, height: "100%",
              background: "linear-gradient(90deg, #0fc6c2, #06b6d4)",
              borderRadius: 4, transition: "width 0.3s ease"
            }} />
          </div>
          <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
            {Math.round(submitProgress)}%
          </div>
        </div>
      )}

      {/* 提交结果汇总弹窗 */}
      {submitResult && (
        <div style={{
          position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 10000,
          background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center"
        }}>
          <div className="card" style={{
            width: 460, padding: 32, textAlign: "center",
            boxShadow: "0 20px 60px rgba(0,0,0,0.3)", borderRadius: 16
          }}>
            {/* 图标 */}
            <div style={{
              width: 64, height: 64, borderRadius: "50%", margin: "0 auto 20px",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 32,
              background: submitResult.failCount === 0 ? "#ecfdf5" : "#fef3c7"
            }}>
              {submitResult.failCount === 0 ? "✅" : "⚠️"}
            </div>

            <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>
              {submitResult.failCount === 0 ? "提交成功" : "提交完成"}
            </h2>

            {/* 统计数字 */}
            <div style={{
              display: "flex", justifyContent: "center", gap: 32, margin: "20px 0",
              padding: "16px", background: "#f8fafc", borderRadius: 12
            }}>
              <div>
                <div style={{ fontSize: 28, fontWeight: 700, color: "var(--primary)" }}>
                  {submitResult.successCount}
                </div>
                <div style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4 }}>成功</div>
              </div>
              {submitResult.failCount > 0 && (
                <div>
                  <div style={{ fontSize: 28, fontWeight: 700, color: "var(--error)" }}>
                    {submitResult.failCount}
                  </div>
                  <div style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4 }}>失败</div>
                </div>
              )}
              <div>
                <div style={{ fontSize: 28, fontWeight: 700, color: "var(--text-primary)" }}>
                  {submitResult.total}
                </div>
                <div style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4 }}>总计</div>
              </div>
            </div>

            {/* 错误详情 */}
            {submitResult.errors && submitResult.errors.length > 0 && (
              <div style={{
                textAlign: "left", maxHeight: 120, overflow: "auto",
                background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8,
                padding: 12, marginBottom: 16, fontSize: 12
              }}>
                <div style={{ fontWeight: 600, color: "var(--error)", marginBottom: 6 }}>错误详情：</div>
                {submitResult.errors.map((err, i) => (
                  <div key={i} style={{ color: "#991b1b", marginBottom: 2 }}>• {err}</div>
                ))}
              </div>
            )}

            {/* 批次信息 */}
            {submitResult.batchId && (
              <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 20 }}>
                批次号：{submitResult.batchId}
              </div>
            )}

            {/* 按钮 */}
            <button className="btn btn-primary" onClick={closeResult} style={{ width: "100%" }}>
              {submitResult.failCount === 0 ? "查看历史记录" : "关闭"}
            </button>
          </div>
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700 }}>数据预览</h1>
          <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4 }}>
            共 {orders.length} 条记录 · {errors.length} 个错误 · {duplicates.size} 个重复
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn btn-secondary" onClick={addRow} disabled={submitting}>➕ 新增行</button>
          <button className="btn btn-secondary" onClick={exportToExcel} disabled={submitting}>📥 导出 Excel</button>
          <button
            className="btn btn-primary"
            disabled={hasAnyError || submitting}
            onClick={handleSubmit}
            style={{ minWidth: 120 }}
          >
            {submitting ? "提交中..." : hasAnyError ? `有 ${errors.length} 个错误待修正` : "📤 提交下单"}
          </button>
        </div>
      </div>

      {/* Error Summary */}
      {errors.length > 0 && (
        <div style={{ padding: "10px 16px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, marginBottom: 12, fontSize: 13 }}>
          <strong style={{ color: "var(--error)" }}>⚠️ 校验未通过，请修正以下错误</strong>
          <div style={{ display: "flex", gap: 16, marginTop: 6, flexWrap: "wrap" }}>
            {Object.entries(errorSummary).map(([field, count]) => (
              <span key={field} style={{ color: "var(--error)", fontSize: 12 }}>
                {field}: {count} 个错误
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Data Table */}
      <div className="card" style={{ overflow: "hidden" }}>
        <div className="table-wrapper" ref={tableRef} onScroll={() => {
          if (tableRef.current) setScrollTop(tableRef.current.scrollTop);
        }}>
          <table className="data-table" style={{ position: "relative" }}>
            <thead>
              <tr style={{ height: HEADER_HEIGHT }}>
                <th style={{ width: 40, position: "sticky", left: 0, zIndex: 11, background: "#f8fafc" }}>#</th>
                <th style={{ width: 60, position: "sticky", left: 40, zIndex: 11, background: "#f8fafc" }}>操作</th>
                {TARGET_FIELDS.map((f) => (
                  <th key={f.key} style={{ minWidth: 120 }}>{f.label}</th>
                ))}
              </tr>
            </thead>
            <tbody style={{ height: totalHeight }}>
              {visibleOrders.map((order, visIdx) => {
                const realIdx = startIdx + visIdx;
                const isDuplicate = duplicates.has(realIdx);
                const rowErrors = errors.filter((e) => e.rowIndex === realIdx);

                return (
                  <tr
                    key={realIdx}
                    style={{
                      position: "absolute",
                      top: startIdx * ROW_HEIGHT + visIdx * ROW_HEIGHT,
                      height: ROW_HEIGHT,
                      left: 0,
                      right: 0,
                      background: realIdx % 2 === 0 ? "white" : "#fafbfc",
                    }}
                  >
                    <td style={{ width: 40, position: "sticky", left: 0, zIndex: 1, background: "inherit", fontSize: 12, color: "var(--text-secondary)", textAlign: "center" }}>
                      {realIdx + 1}
                    </td>
                    <td style={{ width: 60, position: "sticky", left: 40, zIndex: 1, background: "inherit" }}>
                      <button className="btn btn-ghost btn-sm" style={{ color: "var(--error)", fontSize: 11 }} onClick={() => deleteRow(realIdx)}>
                        ✕
                      </button>
                    </td>
                    {TARGET_FIELDS.map((f) => {
                      const cellErrors = rowErrors.filter((e) => e.field === f.key);
                      const isEditing = editingCell?.row === realIdx && editingCell?.field === f.key;
                      let val = (order as any)[f.key];
                      val = val === undefined || val === null ? "" : String(val);

                      return (
                        <td
                          key={f.key}
                          className={`editable ${isEditing ? "editing" : ""} ${cellErrors.length > 0 ? "error" : ""} ${isDuplicate && (f.key === "外部编码") ? "duplicate" : ""}`}
                          data-error={cellErrors.map((e) => e.message).join("; ")}
                          style={{ minWidth: 120, position: "relative", background: isEditing ? undefined : undefined }}
                          onClick={() => {
                            if (!isEditing) setEditingCell({ row: realIdx, field: f.key });
                          }}
                        >
                          {isEditing ? (
                            <input
                              autoFocus
                              type={f.key === "SKU发货数量" ? "number" : "text"}
                              value={val}
                              onChange={(e) => updateCell(realIdx, f.key, e.target.value)}
                              onBlur={() => setEditingCell(null)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") setEditingCell(null);
                                if (e.key === "Tab") {
                                  e.preventDefault();
                                  const idx = TARGET_FIELDS.findIndex((ff) => ff.key === f.key);
                                  const nextField = TARGET_FIELDS[(idx + 1) % TARGET_FIELDS.length].key;
                                  setEditingCell({ row: realIdx, field: nextField });
                                }
                              }}
                            />
                          ) : (
                            <span style={{
                              fontSize: 13,
                              color: cellErrors.length > 0 ? "var(--error)" : isDuplicate && f.key === "外部编码" ? "#b45309" : "var(--text-primary)",
                              fontWeight: f.key === "SKU物品编码" || f.key === "SKU物品名称" ? 500 : 400,
                            }}>
                              {val || <span style={{ color: "#cbd5e1" }}>-</span>}
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
