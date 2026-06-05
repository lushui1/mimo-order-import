"use client";

import { useState, useEffect, useCallback } from "react";
import type { ParsedOrder } from "@/lib/types";

const PAGE_SIZE = 20;

export default function HistoryPage() {
  const [orders, setOrders] = useState<ParsedOrder[]>([]);
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState<ParsedOrder | null>(null);

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

  const totalPages = Math.ceil(total / PAGE_SIZE);

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
          共 {total} 条运单记录
        </p>
      </div>

      {/* Filters */}
      <div className="card" style={{ padding: "16px 20px", marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
          {/* 搜索 */}
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

          {/* 日期范围 */}
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
            <div>
              <label style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 4, display: "block" }}>
                提交时间从
              </label>
              <input
                className="input"
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                style={{ width: 150 }}
              />
            </div>
            <div>
              <label style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 4, display: "block" }}>
                至
              </label>
              <input
                className="input"
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                style={{ width: 150 }}
              />
            </div>
            <button className="btn btn-secondary btn-sm" onClick={handleDateFilter}>
              🔍 筛选
            </button>
            <button className="btn btn-ghost btn-sm" onClick={clearFilters}>
              清除
            </button>
          </div>
        </div>
      </div>

      {/* Orders Table */}
      <div className="card">
        <div className="table-wrapper" style={{ maxHeight: "none" }}>
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: 40 }}>#</th>
                <th>外部编码</th>
                <th>收货门店</th>
                <th>收件人</th>
                <th>电话</th>
                <th>SKU编码</th>
                <th>SKU名称</th>
                <th>数量</th>
                <th>规格</th>
                <th style={{ width: 100 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={10} style={{ textAlign: "center", padding: 40, color: "var(--text-secondary)" }}>
                    加载中...
                  </td>
                </tr>
              ) : orders.length === 0 ? (
                <tr>
                  <td colSpan={10} style={{ textAlign: "center", padding: 40, color: "var(--text-secondary)" }}>
                    {search || dateFrom || dateTo ? "未找到匹配记录" : "暂无运单数据，请先导入"}
                  </td>
                </tr>
              ) : (
                orders.map((order, idx) => (
                  <tr key={order.rowIndex || idx}>
                    <td style={{ fontSize: 12, color: "var(--text-secondary)" }}>{page * PAGE_SIZE + idx + 1}</td>
                    <td style={{ fontWeight: 500 }}>{order.外部编码 || "-"}</td>
                    <td>{order.收货门店 || "-"}</td>
                    <td>{order.收件人姓名 || "-"}</td>
                    <td>{order.收件人电话 || "-"}</td>
                    <td style={{ fontSize: 12, fontFamily: "monospace" }}>{order.SKU物品编码}</td>
                    <td>{order.SKU物品名称}</td>
                    <td style={{ textAlign: "right" }}>{order.SKU发货数量}</td>
                    <td style={{ fontSize: 12, color: "var(--text-secondary)" }}>{order.SKU规格型号 || "-"}</td>
                    <td>
                      <button className="btn btn-ghost btn-sm" onClick={() => setSelectedOrder(order)}>
                        详情
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div style={{ padding: "12px 16px", display: "flex", justifyContent: "center", alignItems: "center", gap: 8, borderTop: "1px solid var(--border)" }}>
            <button className="btn btn-ghost btn-sm" disabled={page === 0} onClick={() => setPage(page - 1)}>
              上一页
            </button>
            <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
              第 {page + 1} / {totalPages} 页（共 {total} 条）
            </span>
            <button className="btn btn-ghost btn-sm" disabled={page >= totalPages - 1} onClick={() => setPage(page + 1)}>
              下一页
            </button>
          </div>
        )}
      </div>

      {/* Detail Modal */}
      {selectedOrder && (
        <div className="modal-overlay" onClick={() => setSelectedOrder(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 500 }}>
            <div className="modal-header">
              <h3 style={{ fontSize: 16, fontWeight: 600 }}>运单详情</h3>
              <button className="btn btn-ghost btn-sm" onClick={() => setSelectedOrder(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                {[
                  ["外部编码", selectedOrder.外部编码],
                  ["收货门店", selectedOrder.收货门店],
                  ["收件人姓名", selectedOrder.收件人姓名],
                  ["收件人电话", selectedOrder.收件人电话],
                  ["收件人地址", selectedOrder.收件人地址],
                  ["SKU物品编码", selectedOrder.SKU物品编码],
                  ["SKU物品名称", selectedOrder.SKU物品名称],
                  ["SKU发货数量", String(selectedOrder.SKU发货数量)],
                  ["SKU规格型号", selectedOrder.SKU规格型号],
                  ["备注", selectedOrder.备注],
                ].map(([label, value]) => (
                  <div key={label}>
                    <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 2 }}>{label}</div>
                    <div style={{ fontSize: 14, fontWeight: 500 }}>{value || "-"}</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setSelectedOrder(null)}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
