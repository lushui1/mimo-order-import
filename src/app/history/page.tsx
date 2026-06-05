"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import type { ParsedOrder } from "@/lib/types";

const PAGE_SIZE = 50; // 每页取更多数据，因为聚合后显示数量会减少

interface OrderGroup {
  externalCode: string;
  receiverName: string;
  receiverPhone: string;
  receiverAddress: string;
  receiveStore: string;
  items: ParsedOrder[];
  batchId?: string;
  createdAt?: string;
  sourceFile?: string;
}

export default function HistoryPage() {
  const [orders, setOrders] = useState<ParsedOrder[]>([]);
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const fetchOrders = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(PAGE_SIZE),
      });
      if (search.trim()) params.set("search", search.trim());
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo) params.set("dateTo", dateTo);

      const res = await fetch(`/api/orders?${params}`);
      if (!res.ok) throw new Error("Failed to fetch");
      const data = await res.json();
      setOrders(data.orders || []);
      setTotal(data.total || 0);
    } catch (e) {
      console.error("Fetch orders error:", e);
      setOrders([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [page, search, dateFrom, dateTo]);

  useEffect(() => {
    fetchOrders();
  }, [fetchOrders]);

  // Debounce search
  const [searchInput, setSearchInput] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput);
      setPage(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // 按外部编码聚合
  const groups = useMemo<OrderGroup[]>(() => {
    const map = new Map<string, OrderGroup>();

    for (const order of orders) {
      const key = String(order.外部编码 || "").trim() || `__ungrouped_${order.rowIndex || Math.random()}`;

      if (!map.has(key)) {
        map.set(key, {
          externalCode: key,
          receiverName: order.收件人姓名 || "",
          receiverPhone: order.收件人电话 || "",
          receiverAddress: order.收件人地址 || "",
          receiveStore: order.收货门店 || "",
          items: [],
          batchId: (order as any)._batchId || undefined,
          createdAt: (order as any)._createdAt || undefined,
          sourceFile: (order as any)._sourceFile || undefined,
        });
      }

      const group = map.get(key)!;
      // 取第一个非空值作为收货信息
      if (!group.receiverName && order.收件人姓名) group.receiverName = order.收件人姓名;
      if (!group.receiverPhone && order.收件人电话) group.receiverPhone = order.收件人电话;
      if (!group.receiverAddress && order.收件人地址) group.receiverAddress = order.收件人地址;
      if (!group.receiveStore && order.收货门店) group.receiveStore = order.收货门店;

      group.items.push(order);
    }

    return Array.from(map.values());
  }, [orders]);

  // 统计
  const totalGroups = groups.length;
  const totalItems = orders.length;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  const toggleGroup = (key: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const expandAll = () => {
    setExpandedGroups(new Set(groups.map(g => g.externalCode)));
  };

  const collapseAll = () => {
    setExpandedGroups(new Set());
  };

  const handleDateFilter = () => {
    setPage(0);
    fetchOrders();
  };

  const clearFilters = () => {
    setSearchInput("");
    setSearch("");
    setDateFrom("");
    setDateTo("");
    setPage(0);
  };

  return (
    <div className="fade-in">
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700 }}>已导入运单</h1>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4 }}>
          共 {totalGroups} 个出库单 · {totalItems} 条SKU记录（总记录 {total} 条）
        </p>
      </div>

      {/* Filters */}
      <div className="card" style={{ padding: "16px 20px", marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div style={{ flex: "1 1 240px" }}>
            <label style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 4, display: "block" }}>
              搜索（外部编码/收件人/门店/物品）
            </label>
            <input
              className="input"
              placeholder="输入关键词搜索..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              style={{ width: "100%" }}
            />
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
            <div>
              <label style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 4, display: "block" }}>
                提交时间从
              </label>
              <input className="input" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} style={{ width: 150 }} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 4, display: "block" }}>
                至
              </label>
              <input className="input" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={{ width: 150 }} />
            </div>
            <button className="btn btn-secondary btn-sm" onClick={handleDateFilter}>🔍 筛选</button>
            <button className="btn btn-ghost btn-sm" onClick={clearFilters}>清除</button>
          </div>
        </div>
      </div>

      {/* 操作栏 */}
      {totalGroups > 0 && (
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <button className="btn btn-ghost btn-sm" onClick={expandAll}>展开全部</button>
          <button className="btn btn-ghost btn-sm" onClick={collapseAll}>折叠全部</button>
        </div>
      )}

      {/* 出库单卡片列表 */}
      {loading ? (
        <div className="card" style={{ padding: 40, textAlign: "center", color: "var(--text-secondary)" }}>
          加载中...
        </div>
      ) : totalGroups === 0 ? (
        <div className="card" style={{ padding: 40, textAlign: "center", color: "var(--text-secondary)" }}>
          {search || dateFrom || dateTo ? "未找到匹配记录" : "暂无运单数据，请先导入"}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {groups.map((group) => {
            const isExpanded = expandedGroups.has(group.externalCode);
            const skuCount = group.items.length;
            const totalQty = group.items.reduce((s, o) => s + (Number(o.SKU发货数量) || 0), 0);

            return (
              <div key={group.externalCode} className="card" style={{ overflow: "hidden" }}>
                {/* 出库单头部 - 始终可见 */}
                <div
                  style={{
                    padding: "12px 16px",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    cursor: "pointer",
                    borderBottom: isExpanded ? "1px solid var(--border)" : "none",
                    background: "var(--bg-secondary)",
                  }}
                  onClick={() => toggleGroup(group.externalCode)}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <span style={{ fontSize: 11, color: "var(--text-secondary)", width: 20, textAlign: "center" }}>
                      {isExpanded ? "▼" : "▶"}
                    </span>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontWeight: 600, fontSize: 14, color: "var(--primary)" }}>
                          {group.externalCode.startsWith("__ungrouped") ? "无单号" : group.externalCode}
                        </span>
                        {group.receiveStore && (
                          <span style={{
                            fontSize: 11,
                            padding: "2px 6px",
                            borderRadius: 4,
                            background: "var(--primary-light)",
                            color: "var(--primary)",
                          }}>
                            {group.receiveStore}
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
                        {skuCount} 种SKU · 合计 {totalQty} 件
                        {group.receiverName && ` · ${group.receiverName}`}
                        {group.createdAt && ` · ${new Date(group.createdAt).toLocaleDateString()}`}
                      </div>
                    </div>
                  </div>
                </div>

                {/* 收货信息（展开时可见） */}
                {isExpanded && (group.receiverName || group.receiverPhone || group.receiverAddress) && (
                  <div style={{
                    padding: "10px 16px 10px 48px",
                    background: "rgba(15, 198, 194, 0.04)",
                    borderBottom: "1px solid var(--border)",
                    display: "flex",
                    gap: 20,
                    flexWrap: "wrap",
                    fontSize: 13,
                  }}>
                    {group.receiverName && (
                      <div><span style={{ color: "var(--text-secondary)", marginRight: 4 }}>收件人:</span>{group.receiverName}</div>
                    )}
                    {group.receiverPhone && (
                      <div><span style={{ color: "var(--text-secondary)", marginRight: 4 }}>电话:</span>{group.receiverPhone}</div>
                    )}
                    {group.receiverAddress && (
                      <div><span style={{ color: "var(--text-secondary)", marginRight: 4 }}>地址:</span>{group.receiverAddress}</div>
                    )}
                    {group.sourceFile && (
                      <div><span style={{ color: "var(--text-secondary)", marginRight: 4 }}>来源:</span>{group.sourceFile}</div>
                    )}
                  </div>
                )}

                {/* SKU 明细表（展开时可见） */}
                {isExpanded && (
                  <div style={{ overflowX: "auto" }}>
                    <table className="data-table" style={{ fontSize: 13 }}>
                      <thead>
                        <tr>
                          <th style={{ width: 40 }}>#</th>
                          <th>SKU编码</th>
                          <th>SKU名称</th>
                          <th>数量</th>
                          <th>规格</th>
                          <th>备注</th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.items.map((item, idx) => (
                          <tr key={item.rowIndex || idx}>
                            <td style={{ color: "var(--text-secondary)" }}>{idx + 1}</td>
                            <td style={{ fontFamily: "monospace", fontSize: 12 }}>{item.SKU物品编码}</td>
                            <td>{item.SKU物品名称}</td>
                            <td style={{ textAlign: "right", fontWeight: 500 }}>{item.SKU发货数量}</td>
                            <td style={{ fontSize: 12, color: "var(--text-secondary)" }}>{item.SKU规格型号 || "-"}</td>
                            <td style={{ fontSize: 12, color: "var(--text-secondary)" }}>{item.备注 || "-"}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr style={{ background: "var(--bg-secondary)", fontWeight: 600 }}>
                          <td colSpan={3} style={{ textAlign: "right" }}>合计</td>
                          <td style={{ textAlign: "right" }}>{totalQty}</td>
                          <td colSpan={2}></td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{
          marginTop: 16,
          padding: "12px 16px",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          gap: 8,
        }}>
          <button className="btn btn-ghost btn-sm" disabled={page === 0} onClick={() => setPage(page - 1)}>
            上一页
          </button>
          <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
            第 {page + 1} / {totalPages} 页（共 {total} 条记录）
          </span>
          <button className="btn btn-ghost btn-sm" disabled={page >= totalPages - 1} onClick={() => setPage(page + 1)}>
            下一页
          </button>
        </div>
      )}
    </div>
  );
}
