"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { getRules, saveRule, deleteRule, generateId, setCurrentOrders } from "@/lib/store";
import { getDefaultRules } from "@/lib/rule-engine/presets";
import { parseFile } from "@/lib/rule-engine/file-parser";
import { executeRule } from "@/lib/rule-engine/rule-executor";
import type { ParseRule, ParsedOrder } from "@/lib/types";
import { useToast } from "@/components/ToastProvider";

export default function RulesPage() {
  const [rules, setRules] = useState<ParseRule[]>([]);
  const [showEditor, setShowEditor] = useState(false);
  const [editingRule, setEditingRule] = useState<ParseRule | null>(null);
  const [showPresets, setShowPresets] = useState(false);
  const [showTestResult, setShowTestResult] = useState(false);
  const [testResults, setTestResults] = useState<ParsedOrder[]>([]);
  const [testing, setTesting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const toast = useToast();

  useEffect(() => {
    const saved = getRules();
    if (saved.length === 0) {
      // Auto-load presets on first visit
      const presets = getDefaultRules();
      presets.forEach((r) => saveRule(r));
      setRules(getRules());
    } else {
      setRules(saved);
    }
  }, []);

  const refreshRules = () => {
    setRules(getRules());
  };

  const handleDelete = (id: string, name: string) => {
    if (confirm(`确认删除规则 "${name}"？`)) {
      deleteRule(id);
      refreshRules();
      toast.showToast(`已删除规则: ${name}`, "success");
    }
  };

  const handleDuplicate = (rule: ParseRule) => {
    const newRule: ParseRule = {
      ...JSON.parse(JSON.stringify(rule)),
      id: generateId(),
      name: rule.name + " (副本)",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      aiGenerated: false,
    };
    saveRule(newRule);
    refreshRules();
    toast.showToast("已复制规则", "success");
  };

  const openNewRule = () => {
    setEditingRule({
      id: generateId(),
      name: "",
      description: "",
      fileType: "excel",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      header: { skipRows: 0, headerRow: 0 },
      columnMappings: [],
    });
    setShowEditor(true);
  };

  const openEditRule = (rule: ParseRule) => {
    setEditingRule({ ...rule });
    setShowEditor(true);
  };

  const handleSaveRule = () => {
    if (!editingRule) return;
    if (!editingRule.name.trim()) {
      toast.showToast("请输入规则名称", "error");
      return;
    }
    if (editingRule.columnMappings.length === 0 && !editingRule.cardBoundary?.enabled) {
      toast.showToast("请至少添加一个列映射", "error");
      return;
    }
    const result = saveRule(editingRule);
    if (!result.success) {
      toast.showToast(result.error || "保存失败", "error");
      return;
    }
    refreshRules();
    setShowEditor(false);
    setEditingRule(null);
    toast.showToast("规则已保存", "success");
  };

  const loadPresets = () => {
    const presets = getDefaultRules();
    presets.forEach((r) => saveRule(r));
    refreshRules();
    setShowPresets(false);
    toast.showToast("已加载 6 条预置规则", "success");
  };

  // 试解析功能
  const handleTestParse = () => {
    if (!editingRule) return;
    if (editingRule.columnMappings.length === 0 && !editingRule.cardBoundary?.enabled) {
      toast.showToast("请至少添加一个列映射后再试解析", "error");
      return;
    }
    // 触发文件选择
    fileInputRef.current?.click();
  };

  const handleTestFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !editingRule) return;

    setTesting(true);
    try {
      const buffer = await file.arrayBuffer();
      const rawFile = await parseFile(file, buffer);
      const orders = await executeRule(editingRule, rawFile);
      setTestResults(orders);
      setShowTestResult(true);

      if (orders.length === 0) {
        toast.showToast("解析结果为空，请检查规则配置", "info");
      } else {
        toast.showToast(`试解析成功，共 ${orders.length} 条记录`, "success");
      }
    } catch (err: any) {
      console.error("Test parse error:", err);
      toast.showToast("试解析失败: " + (err.message || "未知错误"), "error");
    } finally {
      setTesting(false);
      // Reset file input
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  // 将试解析结果导入到预览页面
  const importTestResults = () => {
    if (testResults.length === 0) return;
    setCurrentOrders(testResults);
    setShowTestResult(false);
    router.push("/preview");
  };

  const addMapping = () => {
    if (!editingRule) return;
    setEditingRule({
      ...editingRule,
      columnMappings: [
        ...editingRule.columnMappings,
        { sourceField: "", targetField: "SKU物品编码", isRequired: false },
      ],
    });
  };

  const updateMapping = (index: number, field: string, value: any) => {
    if (!editingRule) return;
    const mappings = [...editingRule.columnMappings];
    mappings[index] = { ...mappings[index], [field]: value };
    setEditingRule({ ...editingRule, columnMappings: mappings });
  };

  const removeMapping = (index: number) => {
    if (!editingRule) return;
    setEditingRule({
      ...editingRule,
      columnMappings: editingRule.columnMappings.filter((_, i) => i !== index),
    });
  };

  const toggleConfig = (key: string, enabled: boolean) => {
    if (!editingRule) return;
    const update: any = { ...editingRule };
    if (key === "footerExtraction") {
      update.footerExtraction = enabled
        ? { enabled: true, sections: [] }
        : { enabled: false, sections: [] };
    } else if (key === "aggregation") {
      update.aggregation = enabled
        ? { enabled: true, groupByField: "", sharedFields: [] }
        : { enabled: false, groupByField: "", sharedFields: [] };
    } else if (key === "matrixTranspose") {
      update.matrixTranspose = enabled
        ? { enabled: true, dimensionColumns: [], dimensionField: "收货门店", quantityField: "SKU发货数量", excludeEmpty: true }
        : { enabled: false, dimensionColumns: [], dimensionField: "", quantityField: "", excludeEmpty: true };
    } else if (key === "multiSheet") {
      update.multiSheet = enabled
        ? { enabled: true, extractStoreName: true }
        : { enabled: false, extractStoreName: false };
    } else if (key === "cardBoundary") {
      update.cardBoundary = enabled
        ? { enabled: true, startPattern: "", headerRowCount: 2, dataHeaderRowCount: 1, dataStartOffset: 3 }
        : { enabled: false, startPattern: "", headerRowCount: 0, dataHeaderRowCount: 0, dataStartOffset: 0 };
    }
    setEditingRule(update);
  };

  const targetFields = [
    "外部编码", "收货门店", "收件人姓名", "收件人电话", "收件人地址",
    "SKU物品编码", "SKU物品名称", "SKU发货数量", "SKU规格型号", "备注"
  ];

  return (
    <div className="fade-in">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700 }}>解析规则管理</h1>
          <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4 }}>
            通用规则描述引擎 · 支持 AI 辅助生成
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn btn-secondary" onClick={() => setShowPresets(true)}>
            📥 加载预置规则
          </button>
          <button className="btn btn-primary" onClick={openNewRule}>
            ➕ 新建规则
          </button>
        </div>
      </div>

      {/* Rules List */}
      <div className="card">
        <div className="card-body" style={{ padding: 0 }}>
          {rules.length === 0 ? (
            <div className="empty-state">
              <div style={{ fontSize: 48, marginBottom: 16 }}>⚙️</div>
              <p style={{ fontWeight: 500 }}>暂无解析规则</p>
              <p style={{ fontSize: 13, marginTop: 4 }}>点击"加载预置规则"或"新建规则"开始</p>
            </div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: 30 }}>#</th>
                  <th>规则名称</th>
                  <th>文件类型</th>
                  <th>列映射数</th>
                  <th>高级配置</th>
                  <th>创建时间</th>
                  <th style={{ width: 150 }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((rule, idx) => (
                  <tr key={rule.id}>
                    <td>{idx + 1}</td>
                    <td>
                      <div style={{ fontWeight: 500 }}>{rule.name}</div>
                      <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>{rule.description}</div>
                    </td>
                    <td>
                      <span className="badge badge-primary">{rule.fileType.toUpperCase()}</span>
                    </td>
                    <td>{rule.columnMappings.length}</td>
                    <td>
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                        {rule.footerExtraction?.enabled && <span className="badge badge-primary">尾部提取</span>}
                        {rule.aggregation?.enabled && <span className="badge badge-warning">聚合</span>}
                        {rule.matrixTranspose?.enabled && <span className="badge badge-primary">转置</span>}
                        {rule.multiSheet?.enabled && <span className="badge badge-primary">多Sheet</span>}
                        {rule.cardBoundary?.enabled && <span className="badge badge-warning">卡片</span>}
                        {!rule.footerExtraction?.enabled && !rule.aggregation?.enabled && 
                         !rule.matrixTranspose?.enabled && !rule.multiSheet?.enabled && 
                         !rule.cardBoundary?.enabled && <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>-</span>}
                      </div>
                    </td>
                    <td style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                      {new Date(rule.createdAt).toLocaleDateString("zh-CN")}
                    </td>
                    <td>
                      <div style={{ display: "flex", gap: 4 }}>
                        <button className="btn btn-ghost btn-sm" onClick={() => openEditRule(rule)}>
                          编辑
                        </button>
                        <button className="btn btn-ghost btn-sm" onClick={() => handleDuplicate(rule)}>
                          复制
                        </button>
                        <button className="btn btn-ghost btn-sm" style={{ color: "var(--error)" }} onClick={() => handleDelete(rule.id, rule.name)}>
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Presets Modal */}
      {showPresets && (
        <div className="modal-overlay" onClick={() => setShowPresets(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 500 }}>
            <div className="modal-header">
              <h3 style={{ fontSize: 16, fontWeight: 600 }}>加载预置规则</h3>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowPresets(false)}>✕</button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 14, color: "var(--text-secondary)", marginBottom: 16 }}>
                将加载 6 条预置解析规则，分别适配当前提供的 6 份 demo 文件格式。
                已有同名校规则将被覆盖。
              </p>
              <ul style={{ fontSize: 13, lineHeight: 1.8, color: "var(--text-secondary)" }}>
                <li>📊 黎明屯配送发货单解析 - 尾部收货人提取</li>
                <li>📊 湖南仓发货明细解析 - 跨行聚合</li>
                <li>📊 欢乐牧场库存转配送单解析 - 矩阵转置</li>
                <li>📊 多门店分Sheet出库单解析 - 多Sheet合并</li>
                <li>📊 门店调拨单卡片式解析 - 卡片边界识别</li>
                <li>📄 黔寨寨配送单PDF解析 - PDF表格+尾部提取</li>
              </ul>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowPresets(false)}>取消</button>
              <button className="btn btn-primary" onClick={loadPresets}>确认加载</button>
            </div>
          </div>
        </div>
      )}

      {/* Rule Editor Modal */}
      {showEditor && editingRule && (
        <div className="modal-overlay" onClick={() => setShowEditor(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 800 }}>
            <div className="modal-header">
              <h3 style={{ fontSize: 16, fontWeight: 600 }}>
                {editingRule.name ? "编辑规则" : "新建规则"}
              </h3>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowEditor(false)}>✕</button>
            </div>
            <div className="modal-body">
              {/* Basic Info */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 20 }}>
                <div>
                  <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, display: "block" }}>规则名称</label>
                  <input className="input" value={editingRule.name} onChange={(e) => setEditingRule({ ...editingRule, name: e.target.value })} placeholder="输入规则名称" />
                </div>
                <div>
                  <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, display: "block" }}>文件类型</label>
                  <select className="input" value={editingRule.fileType} onChange={(e) => setEditingRule({ ...editingRule, fileType: e.target.value as any })}>
                    <option value="excel">Excel</option>
                    <option value="word">Word</option>
                    <option value="pdf">PDF</option>
                  </select>
                </div>
                <div style={{ gridColumn: "1/-1" }}>
                  <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, display: "block" }}>描述</label>
                  <input className="input" value={editingRule.description} onChange={(e) => setEditingRule({ ...editingRule, description: e.target.value })} placeholder="规则用途说明" />
                </div>
              </div>

              {/* Header Config */}
              <div style={{ marginBottom: 20 }}>
                <h4 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>表头配置</h4>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <div>
                    <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, display: "block" }}>跳过前N行（0-based）</label>
                    <input className="input" type="number" value={editingRule.header.skipRows} onChange={(e) => setEditingRule({ ...editingRule, header: { ...editingRule.header, skipRows: parseInt(e.target.value) || 0 } })} />
                  </div>
                  <div>
                    <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, display: "block" }}>表头行号（0-based）</label>
                    <input className="input" type="number" value={editingRule.header.headerRow} onChange={(e) => setEditingRule({ ...editingRule, header: { ...editingRule.header, headerRow: parseInt(e.target.value) || 0 } })} />
                  </div>
                </div>
              </div>

              {/* Column Mappings */}
              <div style={{ marginBottom: 20 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <h4 style={{ fontSize: 14, fontWeight: 600 }}>列映射</h4>
                  <button className="btn btn-sm btn-secondary" onClick={addMapping}>➕ 添加映射</button>
                </div>
                {editingRule.columnMappings.length === 0 ? (
                  <div style={{ fontSize: 13, color: "var(--text-secondary)", padding: 12, textAlign: "center", background: "#f8fafc", borderRadius: 8 }}>
                    暂无列映射，点击"添加映射"开始配置
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {editingRule.columnMappings.map((m, i) => (
                      <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 12px", background: "#f8fafc", borderRadius: 8 }}>
                        <div style={{ flex: 2 }}>
                          <input className="input" value={m.sourceField} onChange={(e) => updateMapping(i, "sourceField", e.target.value)} placeholder="源字段名" />
                        </div>
                        <span style={{ color: "var(--text-secondary)" }}>→</span>
                        <div style={{ flex: 2 }}>
                          <select className="input" value={m.targetField} onChange={(e) => updateMapping(i, "targetField", e.target.value)}>
                            {targetFields.map((f) => <option key={f} value={f}>{f}</option>)}
                          </select>
                        </div>
                        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, whiteSpace: "nowrap" }}>
                          <input type="checkbox" checked={m.isRequired || false} onChange={(e) => updateMapping(i, "isRequired", e.target.checked)} />
                          必填
                        </label>
                        <button className="btn btn-ghost btn-sm" style={{ color: "var(--error)" }} onClick={() => removeMapping(i)}>✕</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Advanced Config */}
              <div style={{ marginBottom: 20 }}>
                <h4 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>高级配置</h4>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {[
                    { key: "footerExtraction", label: "尾部信息提取（收货人信息在表格底部）" },
                    { key: "aggregation", label: "跨行聚合（同单号多行共享收货信息）" },
                    { key: "matrixTranspose", label: "矩阵转置（门店/日期作为列头）" },
                    { key: "multiSheet", label: "多Sheet合并（每个Sheet一个门店）" },
                    { key: "cardBoundary", label: "卡片模式（每条记录独立区域堆叠）" },
                  ].map((item) => {
                    const config: any = (editingRule as any)[item.key];
                    const enabled = config?.enabled || false;
                    return (
                      <label key={item.key} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", cursor: "pointer" }}>
                        <input type="checkbox" checked={enabled} onChange={(e) => toggleConfig(item.key, e.target.checked)} />
                        <span style={{ fontSize: 13 }}>{item.label}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowEditor(false)}>取消</button>
              <button className="btn btn-secondary" onClick={handleTestParse} disabled={testing}>
                {testing ? "解析中..." : "🧪 试解析"}
              </button>
              <button className="btn btn-primary" onClick={handleSaveRule}>保存规则</button>
            </div>
          </div>
        </div>
      )}

      {/* Hidden file input for test parse */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".xlsx,.xls,.docx,.pdf"
        style={{ display: "none" }}
        onChange={handleTestFileSelected}
      />

      {/* Test Result Modal */}
      {showTestResult && (
        <div className="modal-overlay" onClick={() => setShowTestResult(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 900, maxHeight: "80vh" }}>
            <div className="modal-header">
              <h3 style={{ fontSize: 16, fontWeight: 600 }}>
                试解析结果（{testResults.length} 条记录）
              </h3>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowTestResult(false)}>✕</button>
            </div>
            <div className="modal-body" style={{ overflow: "auto", maxHeight: "60vh" }}>
              {testResults.length === 0 ? (
                <div style={{ textAlign: "center", padding: 40, color: "var(--text-secondary)" }}>
                  解析结果为空，请检查规则配置是否正确
                </div>
              ) : (
                <table className="data-table" style={{ fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>外部编码</th>
                      <th>收货门店</th>
                      <th>收件人</th>
                      <th>电话</th>
                      <th>SKU编码</th>
                      <th>SKU名称</th>
                      <th>数量</th>
                      <th>规格</th>
                    </tr>
                  </thead>
                  <tbody>
                    {testResults.slice(0, 50).map((order, idx) => (
                      <tr key={idx}>
                        <td>{idx + 1}</td>
                        <td>{order.外部编码 || "-"}</td>
                        <td>{order.收货门店 || "-"}</td>
                        <td>{order.收件人姓名 || "-"}</td>
                        <td>{order.收件人电话 || "-"}</td>
                        <td style={{ fontFamily: "monospace" }}>{order.SKU物品编码}</td>
                        <td>{order.SKU物品名称}</td>
                        <td style={{ textAlign: "right" }}>{order.SKU发货数量}</td>
                        <td>{order.SKU规格型号 || "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {testResults.length > 50 && (
                <div style={{ textAlign: "center", padding: 12, color: "var(--text-secondary)", fontSize: 12 }}>
                  仅显示前 50 条记录
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowTestResult(false)}>关闭</button>
              {testResults.length > 0 && (
                <button className="btn btn-primary" onClick={importTestResults}>
                  📥 导入到预览页面
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
