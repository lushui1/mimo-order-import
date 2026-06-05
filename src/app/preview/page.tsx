"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { getCurrentOrders, setCurrentOrders, generateId } from "@/lib/store";
import type { ParsedOrder, ValidationError } from "@/lib/types";
import { validatePhone, validateRequired, validateNumberPositive } from "@/lib/utils";
import { useToast } from "@/components/ToastProvider";
import * as XLSX from "xlsx";

const SKU_FIELDS = [
  { key: "SKU物品编码", label: "SKU编码" },
  { key: "SKU物品名称", label: "SKU名称" },
  { key: "SKU发货数量", label: "数量" },
  { key: "SKU规格型号", label: "规格" },
  { key: "备注", label: "备注" },
];

const RECEIVER_FIELDS = [
  { key: "收货门店", label: "门店" },
  { key: "收件人姓名", label: "收件人" },
  { key: "收件人电话", label: "电话" },
  { key: "收件人地址", label: "地址" },
];

// 提交结果类型
interface SubmitResult {
  success: boolean;
  total: number;
  successCount: number;
  failCount: number;
  errors?: string[];
  batchId?: string;
}

// 分组类型
interface OrderGroup {
  groupKey: string;         // 外部编码值
  receiverInfo: Record<string, string>;  // 共享收货信息
  skuLines: ParsedOrder[];  // SKU 行
  indices: number[];        // 在 orders 数组中的原始索引
}

export default function PreviewPage() {
  const [orders, setOrders] = useState<ParsedOrder[]>([]);
  const [editingCell, setEditingCell] = useState<{ row: number; field: string } | null>(null);
  const [errors, setErrors] = useState<ValidationError[]>([]);
  const [duplicates, setDuplicates] = useState<Set<number>>(new Set());
  const [crossBatchDups, setCrossBatchDups] = useState<Set<number>>(new Set());
  const [dupDetails, setDupDetails] = useState<Record<number, string>>({});
  const router = useRouter();
  const toast = useToast();

  // 提交相关状态
  const [submitting, setSubmitting] = useState(false);
  const [submitProgress, setSubmitProgress] = useState(0);
  const [submitResult, setSubmitResult] = useState<SubmitResult | null>(null);

  // 分页
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 20; // 每页显示20个出库单分组

  // 折叠状态
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  useEffect(() => {
    const data = getCurrentOrders();
    if (!data || data.length === 0) {
      toast.showToast("暂无数据，请先导入或重新解析", "info");
      return;
    }
    setOrders(data);
  }, []);

  // ===== 分组计算（useMemo 缓存，O(n) 复杂度）=====
  const groups = useMemo(() => {
    const groupMap = new Map<string, OrderGroup>();

    orders.forEach((order, idx) => {
      const groupKey = String(order.外部编码 || "").trim() || `__ungrouped_${idx}`;

      if (!groupMap.has(groupKey)) {
        groupMap.set(groupKey, {
          groupKey,
          receiverInfo: {},
          skuLines: [],
          indices: [],
        });
      }

      const group = groupMap.get(groupKey)!;
      group.skuLines.push(order);
      group.indices.push(idx);

      // 收集收货信息（取第一个非空值）
      for (const f of RECEIVER_FIELDS) {
        const val = (order as any)[f.key];
        if (val && String(val).trim() && !group.receiverInfo[f.key]) {
          group.receiverInfo[f.key] = String(val).trim();
        }
      }
    });

    return Array.from(groupMap.values());
  }, [orders]);

  const totalPages = Math.ceil(groups.length / PAGE_SIZE);
  const pagedGroups = groups.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  useEffect(() => {
    if (page >= totalPages && totalPages > 0) {
      setPage(Math.max(0, totalPages - 1));
    }
  }, [groups.length, totalPages, page]);

  // ===== 校验 & 重复检测 =====
  useEffect(() => {
    const errs: ValidationError[] = [];
    const extCodes = new Map<string, number[]>();

    orders.forEach((order, idx) => {
      // 必填校验
      if (!validateRequired(order.SKU物品编码)) {
        errs.push({ field: "SKU物品编码", message: "SKU编码必填", rowIndex: idx });
      }
      if (!validateRequired(order.SKU物品名称)) {
        errs.push({ field: "SKU物品名称", message: "SKU名称必填", rowIndex: idx });
      }
      if (!validateNumberPositive(order.SKU发货数量)) {
        errs.push({ field: "SKU发货数量", message: "发货数量必须为正数", rowIndex: idx });
      }

      // A/B 组校验
      const hasStore = validateRequired(order.收货门店);
      const hasPerson = validateRequired(order.收件人姓名) && validateRequired(order.收件人电话) && validateRequired(order.收件人地址);
      if (!hasStore && !hasPerson) {
        errs.push({ field: "收货门店", message: "门店或收件人至少填一组", rowIndex: idx });
      }

      // 电话校验
      if (order.收件人电话 && !validatePhone(order.收件人电话)) {
        errs.push({ field: "收件人电话", message: "电话格式不正确", rowIndex: idx });
      }

      // 收集外部编码用于重复检测
      if (order.外部编码) {
        const code = order.外部编码.trim();
        if (!extCodes.has(code)) extCodes.set(code, []);
        extCodes.get(code)!.push(idx);
      }
    });

    // 同批次重复
    const dupSet = new Set<number>();
    for (const [, indices] of extCodes) {
      if (indices.length > 1) {
        indices.forEach((i) => dupSet.add(i));
      }
    }
    setDuplicates(dupSet);

    // 跨批次重复
    const codesToCheck = Array.from(extCodes.keys()).filter(c => c);
    if (codesToCheck.length > 0) {
      fetch("/api/orders/check-duplicates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ externalCodes: codesToCheck }),
      })
        .then(res => res.json())
        .then(data => {
          const crossSet = new Set<number>();
          const details: Record<number, string> = {};
          if (data.existingCodes && Array.isArray(data.existingCodes)) {
            data.existingCodes.forEach((code: string) => {
              const indices = extCodes.get(code);
              if (indices) {
                indices.forEach((i: number) => {
                  crossSet.add(i);
                  details[i] = `与外部批次 ${data.duplicateWith?.[code] || '未知'} 重复`;
                });
              }
            });
          }
          setCrossBatchDups(crossSet);
          setDupDetails(details);
        })
        .catch(() => {
          setCrossBatchDups(new Set());
          setDupDetails({});
        });
    } else {
      setCrossBatchDups(new Set());
      setDupDetails({});
    }

    setErrors(errs);
  }, [orders]);

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

  // 更新分组的收货信息（同步到该组所有 SKU 行）
  const updateReceiverField = useCallback((groupKey: string, field: string, value: string) => {
    setOrders((prev) => {
      const updated = [...prev];
      for (let i = 0; i < updated.length; i++) {
        if (String(updated[i].外部编码 || "").trim() === groupKey || (!updated[i].外部编码 && groupKey.startsWith("__ungrouped_"))) {
          const order = { ...updated[i] };
          (order as any)[field] = value;
          updated[i] = order;
        }
      }
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

  const toggleGroup = useCallback((groupKey: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) {
        next.delete(groupKey);
      } else {
        next.add(groupKey);
      }
      return next;
    });
  }, []);

  // 提交下单
  const handleSubmit = useCallback(async () => {
    if (errors.length > 0) {
      toast.showToast(`有 ${errors.length} 个错误未修正，无法提交`, "error");
      return;
    }
    if (orders.length === 0) {
      toast.showToast("没有可提交的数据", "error");
      return;
    }
    if (submitting) return;

    setSubmitting(true);
    setSubmitProgress(0);

    try {
      const progressInterval = setInterval(() => {
        setSubmitProgress((prev) => {
          if (prev >= 90) { clearInterval(progressInterval); return 90; }
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
      setCurrentOrders([]);

      if (result.failCount === 0) {
        toast.showToast(`提交成功！共 ${result.successCount} 条运单`, "success");
      } else {
        toast.showToast(`提交完成：成功 ${result.successCount} 条，失败 ${result.failCount} 条`, "info");
      }
    } catch (e: any) {
      setSubmitResult({
        success: false,
        total: orders.length,
        successCount: 0,
        failCount: orders.length,
        errors: [e.message || "提交失败"],
      });
      toast.showToast("提交失败: " + (e.message || "未知错误"), "error");
    } finally {
      setSubmitting(false);
    }
  }, [errors, orders, submitting, toast]);

  const closeResult = useCallback(() => {
    setSubmitResult(null);
    if (submitResult?.success) router.push("/history");
  }, [submitResult, router]);

  const exportToExcel = useCallback(() => {
    const data = orders.map((o, i) => ({
      "出库单号": o.外部编码 || "",
      "收货门店": o.收货门店 || "",
      "收件人": o.收件人姓名 || "",
      "电话": o.收件人电话 || "",
      "地址": o.收件人地址 || "",
      "SKU编码": o.SKU物品编码,
      "SKU名称": o.SKU物品名称,
      "数量": o.SKU发货数量,
      "规格": o.SKU规格型号 || "",
      "备注": o.备注 || "",
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "出库单");
    XLSX.writeFile(wb, `出库单_${new Date().toISOString().slice(0, 10)}.xlsx`);
    toast.showToast("导出成功", "success");
  }, [orders, toast]);

  const hasAnyError = errors.length > 0;

  // 统计出库单数量
  const uniqueOrderCount = groups.length;

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
          <div style={{ fontSize: 15, fontWeight: 600, color: "var(--primary)" }}>正在提交订单...</div>
          <div style={{ width: 400, height: 8, background: "#e5e7eb", borderRadius: 4, overflow: "hidden" }}>
            <div style={{ width: `${submitProgress}%`, height: "100%", background: "linear-gradient(90deg, #0fc6c2, #06b6d4)", borderRadius: 4, transition: "width 0.3s ease" }} />
          </div>
          <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>{Math.round(submitProgress)}%</div>
        </div>
      )}

      {/* 提交结果弹窗 */}
      {submitResult && (
        <div style={{
          position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 10000,
          background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center"
        }}>
          <div className="card" style={{ width: 460, padding: 32, textAlign: "center", boxShadow: "0 20px 60px rgba(0,0,0,0.3)", borderRadius: 16 }}>
            <div style={{ width: 64, height: 64, borderRadius: "50%", margin: "0 auto 20px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 32, background: submitResult.failCount === 0 ? "#ecfdf5" : "#fef3c7" }}>
              {submitResult.failCount === 0 ? "✅" : "⚠️"}
            </div>
            <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>{submitResult.failCount === 0 ? "提交成功" : "提交完成"}</h2>
            <div style={{ display: "flex", justifyContent: "center", gap: 32, margin: "20px 0", padding: "16px", background: "#f8fafc", borderRadius: 12 }}>
              <div>
                <div style={{ fontSize: 28, fontWeight: 700, color: "var(--primary)" }}>{submitResult.successCount}</div>
                <div style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4 }}>成功</div>
              </div>
              {submitResult.failCount > 0 && (
                <div>
                  <div style={{ fontSize: 28, fontWeight: 700, color: "var(--error)" }}>{submitResult.failCount}</div>
                  <div style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4 }}>失败</div>
                </div>
              )}
              <div>
                <div style={{ fontSize: 28, fontWeight: 700, color: "var(--text-primary)" }}>{submitResult.total}</div>
                <div style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4 }}>总计</div>
              </div>
            </div>
            {submitResult.batchId && <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 20 }}>批次号：{submitResult.batchId}</div>}
            <button className="btn btn-primary" onClick={closeResult} style={{ width: "100%" }}>{submitResult.failCount === 0 ? "查看历史记录" : "关闭"}</button>
          </div>
        </div>
      )}

      {/* 顶部操作栏 */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700 }}>数据预览</h1>
          <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4 }}>
            共 {uniqueOrderCount} 个出库单 · {orders.length} 条SKU记录
            {errors.length > 0 && ` · ${errors.length} 个错误`}
            {duplicates.size > 0 && ` · ${duplicates.size} 个同批次重复`}
            {crossBatchDups.size > 0 && ` · ${crossBatchDups.size} 个历史重复`}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn btn-secondary" onClick={addRow} disabled={submitting}>➕ 新增行</button>
          <button className="btn btn-secondary" onClick={exportToExcel} disabled={submitting}>📥 导出</button>
          <button className="btn btn-primary" disabled={hasAnyError || submitting} onClick={handleSubmit} style={{ minWidth: 120 }}>
            {submitting ? "提交中..." : hasAnyError ? `有 ${errors.length} 个错误待修正` : "📤 提交下单"}
          </button>
        </div>
      </div>

      {/* 错误/重复提示 */}
      {(errors.length > 0 || duplicates.size > 0 || crossBatchDups.size > 0) && (
        <div style={{
          padding: "10px 16px",
          background: crossBatchDups.size > 0 ? "#fef2f2" : errors.length > 0 ? "#fef2f2" : "#fffbeb",
          border: `1px solid ${crossBatchDups.size > 0 ? "#fecaca" : errors.length > 0 ? "#fecaca" : "#fcd34d"}`,
          borderRadius: 8, marginBottom: 12, fontSize: 13
        }}>
          <strong style={{ color: crossBatchDups.size > 0 || errors.length > 0 ? "var(--error)" : "#b45309" }}>
            {errors.length > 0 ? `⚠️ 校验未通过：${errors.length} 个错误` : "⚠️ 存在重复"}
          </strong>
          <div style={{ display: "flex", gap: 16, marginTop: 6, flexWrap: "wrap" }}>
            {duplicates.size > 0 && <span style={{ color: "#b45309", fontSize: 12 }}>同批次重复: {duplicates.size} 行</span>}
            {crossBatchDups.size > 0 && <span style={{ color: "var(--error)", fontSize: 12 }}>历史重复: {crossBatchDups.size} 行</span>}
          </div>
        </div>
      )}

      {/* ===== 出库单分组列表 ===== */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {pagedGroups.map((group) => {
          const isCollapsed = collapsedGroups.has(group.groupKey);
          const hasDup = group.indices.some(i => duplicates.has(i));
          const hasCrossDup = group.indices.some(i => crossBatchDups.has(i));

          return (
            <div key={group.groupKey} className="card" style={{
              overflow: "hidden",
              border: hasCrossDup ? "2px solid #ef4444" : hasDup ? "2px solid #f59e0b" : "1px solid var(--border)",
              borderRadius: 12,
              transition: "border-color 0.2s",
            }}>
              {/* ===== 出库单头部：外部编码 + 收货信息 ===== */}
              <div
                onClick={() => toggleGroup(group.groupKey)}
                style={{
                  display: "flex", alignItems: "center", gap: 12,
                  padding: "12px 16px", cursor: "pointer",
                  background: "linear-gradient(135deg, #f0fdfa 0%, #f8fafc 100%)",
                  borderBottom: isCollapsed ? "none" : "1px solid var(--border)",
                  userSelect: "none",
                }}
              >
                {/* 折叠图标 */}
                <span style={{
                  fontSize: 12, color: "var(--text-secondary)",
                  transition: "transform 0.2s",
                  transform: isCollapsed ? "rotate(-90deg)" : "rotate(0deg)",
                  display: "inline-block",
                }}>▼</span>

                {/* 外部编码 */}
                <div style={{
                  fontWeight: 700, fontSize: 15, color: "var(--primary)",
                  background: "rgba(15,198,194,0.1)", padding: "4px 12px",
                  borderRadius: 6,
                }}>
                  {group.groupKey.startsWith("__ungrouped_") ? "未分组" : group.groupKey}
                </div>

                {/* 收货信息摘要 */}
                <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13, color: "var(--text-secondary)", flex: 1 }}>
                  {group.receiverInfo["收货门店"] && (
                    <span>🏪 {group.receiverInfo["收货门店"]}</span>
                  )}
                  {group.receiverInfo["收件人姓名"] && (
                    <span>👤 {group.receiverInfo["收件人姓名"]}</span>
                  )}
                  {group.receiverInfo["收件人电话"] && (
                    <span>📞 {group.receiverInfo["收件人电话"]}</span>
                  )}
                </div>

                {/* SKU 数量 badge */}
                <div style={{
                  background: "var(--primary)", color: "white",
                  padding: "2px 10px", borderRadius: 12, fontSize: 12, fontWeight: 600,
                }}>
                  {group.skuLines.length} SKU
                </div>

                {/* 重复标记 */}
                {hasCrossDup && <span style={{ fontSize: 12, color: "var(--error)", fontWeight: 600 }}>⚠️历史重复</span>}
                {hasDup && !hasCrossDup && <span style={{ fontSize: 12, color: "#b45309", fontWeight: 600 }}>⚠️重复</span>}
              </div>

              {/* ===== 折叠内容：收货信息 + SKU 表 ===== */}
              {!isCollapsed && (
                <div>
                  {/* 收货信息栏（可编辑） */}
                  <div style={{
                    display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                    gap: 8, padding: "10px 16px", background: "#f8fafc",
                    borderBottom: "1px solid var(--border)",
                  }}>
                    {RECEIVER_FIELDS.map((f) => {
                      const val = group.receiverInfo[f.key] || "";
                      const isEditing = editingCell?.row === -1 && editingCell?.field === `${group.groupKey}__${f.key}`;
                      return (
                        <div key={f.key} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span style={{ fontSize: 12, color: "var(--text-secondary)", minWidth: 36 }}>{f.label}</span>
                          {isEditing ? (
                            <input
                              autoFocus
                              type="text"
                              value={val}
                              style={{
                                flex: 1, padding: "4px 8px", border: "1px solid var(--primary)",
                                borderRadius: 4, fontSize: 13, outline: "none",
                              }}
                              onChange={(e) => updateReceiverField(group.groupKey, f.key, e.target.value)}
                              onBlur={() => setEditingCell(null)}
                              onKeyDown={(e) => { if (e.key === "Enter") setEditingCell(null); }}
                            />
                          ) : (
                            <span
                              style={{
                                flex: 1, fontSize: 13, fontWeight: 500,
                                color: val ? "var(--text-primary)" : "#cbd5e1",
                                padding: "4px 8px", borderRadius: 4,
                                cursor: "pointer", border: "1px solid transparent",
                              }}
                              onClick={(e) => { e.stopPropagation(); setEditingCell({ row: -1, field: `${group.groupKey}__${f.key}` }); }}
                            >
                              {val || "-"}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {/* SKU 明细表 */}
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: "#f1f5f9" }}>
                        <th style={{ padding: "8px 12px", textAlign: "left", width: 44, fontSize: 12, color: "var(--text-secondary)" }}>#</th>
                        <th style={{ padding: "8px 12px", textAlign: "left", width: 44 }}></th>
                        {SKU_FIELDS.map((f) => (
                          <th key={f.key} style={{ padding: "8px 12px", textAlign: "left", fontSize: 12, color: "var(--text-secondary)" }}>{f.label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {group.skuLines.map((order, skuIdx) => {
                        const realIdx = group.indices[skuIdx];
                        const rowErrors = errors.filter((e) => e.rowIndex === realIdx);
                        const isDup = duplicates.has(realIdx);
                        const isCrossDup = crossBatchDups.has(realIdx);

                        return (
                          <tr key={realIdx} style={{
                            background: isCrossDup ? "#fef2f2" : isDup ? "#fffbeb" : skuIdx % 2 === 0 ? "white" : "#fafbfc",
                            borderBottom: "1px solid var(--border)",
                          }}>
                            <td style={{ padding: "6px 12px", fontSize: 12, color: "var(--text-secondary)", textAlign: "center" }}>
                              {skuIdx + 1}
                            </td>
                            <td style={{ padding: "6px 12px" }}>
                              <button
                                className="btn btn-ghost btn-sm"
                                style={{ color: "var(--error)", fontSize: 11 }}
                                onClick={() => deleteRow(realIdx)}
                              >✕</button>
                            </td>
                            {SKU_FIELDS.map((f) => {
                              const cellErrors = rowErrors.filter((e) => e.field === f.key);
                              const isEditing = editingCell?.row === realIdx && editingCell?.field === f.key;
                              let val = (order as any)[f.key];
                              val = val === undefined || val === null ? "" : String(val);

                              return (
                                <td
                                  key={f.key}
                                  style={{
                                    padding: "6px 12px",
                                    borderLeft: cellErrors.length > 0 ? "2px solid var(--error)" : undefined,
                                    cursor: "pointer",
                                  }}
                                  onClick={() => { if (!isEditing) setEditingCell({ row: realIdx, field: f.key }); }}
                                >
                                  {isEditing ? (
                                    <input
                                      autoFocus
                                      type={f.key === "SKU发货数量" ? "number" : "text"}
                                      value={val}
                                      style={{
                                        width: "100%", padding: "2px 4px",
                                        border: "1px solid var(--primary)", borderRadius: 3,
                                        fontSize: 13, outline: "none",
                                      }}
                                      onChange={(e) => updateCell(realIdx, f.key, e.target.value)}
                                      onBlur={() => setEditingCell(null)}
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter") setEditingCell(null);
                                        if (e.key === "Tab") {
                                          e.preventDefault();
                                          const idx = SKU_FIELDS.findIndex((ff) => ff.key === f.key);
                                          const nextField = SKU_FIELDS[(idx + 1) % SKU_FIELDS.length].key;
                                          setEditingCell({ row: realIdx, field: nextField });
                                        }
                                      }}
                                    />
                                  ) : (
                                    <span style={{
                                      fontSize: 13,
                                      color: cellErrors.length > 0 ? "var(--error)" : "var(--text-primary)",
                                      fontWeight: f.key === "SKU物品编码" ? 500 : 400,
                                    }}>
                                      {val || <span style={{ color: "#cbd5e1" }}>-</span>}
                                    </span>
                                  )}
                                  {cellErrors.length > 0 && !isEditing && (
                                    <div style={{ fontSize: 11, color: "var(--error)", marginTop: 2 }}>
                                      {cellErrors[0].message}
                                    </div>
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
              )}
            </div>
          );
        })}
      </div>

      {/* 分页控件 */}
      {totalPages > 1 && (
        <div style={{
          display: "flex", justifyContent: "center", alignItems: "center",
          gap: 8, padding: "16px 0", fontSize: 13
        }}>
          <button className="btn btn-ghost btn-sm" disabled={page === 0} onClick={() => setPage(0)}>««</button>
          <button className="btn btn-ghost btn-sm" disabled={page === 0} onClick={() => setPage(p => p - 1)}>‹</button>
          <span style={{ color: "var(--text-secondary)" }}>
            第 {page + 1} / {totalPages} 页 · 共 {uniqueOrderCount} 个出库单
          </span>
          <button className="btn btn-ghost btn-sm" disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>›</button>
          <button className="btn btn-ghost btn-sm" disabled={page >= totalPages - 1} onClick={() => setPage(totalPages - 1)}>»»</button>
        </div>
      )}
    </div>
  );
}
