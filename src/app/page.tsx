"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getRules, getOrders } from "@/lib/store";

export default function Home() {
  const [ruleCount, setRuleCount] = useState(0);
  const [orderCount, setOrderCount] = useState(0);

  useEffect(() => {
    setRuleCount(getRules().length);
    setOrderCount(getOrders().length);
  }, []);

  const stats = [
    { label: "解析规则", value: ruleCount, color: "#0fc6c2", icon: "⚙️" },
    { label: "已导入运单", value: orderCount, color: "#10b981", icon: "📦" },
    { label: "支持格式", value: "3", color: "#6366f1", icon: "📄", sub: "Excel / Word / PDF" },
    { label: "规则引擎", value: ruleCount > 0 ? "已就绪" : "待配置", color: "#f59e0b", icon: "🔧" },
  ];

  return (
    <div className="fade-in">
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: "var(--text-primary)" }}>
          万能导入 V2
        </h1>
        <p style={{ fontSize: 14, color: "var(--text-secondary)", marginTop: 4 }}>
          智能多格式批量下单系统 · AI 驱动规则引擎
        </p>
      </div>

      {/* Stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 24 }}>
        {stats.map((s) => (
          <div key={s.label} className="card" style={{ padding: 20, cursor: "default" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ fontSize: 28 }}>{s.icon}</span>
              <div>
                <div style={{ fontSize: 28, fontWeight: 700, color: s.color }}>{s.value}</div>
                <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>{s.label}</div>
                {"sub" in s && <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>{s.sub}</div>}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Quick Actions */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 24 }}>
        <Link href="/upload" style={{ textDecoration: "none" }}>
          <div className="card" style={{ padding: 28, cursor: "pointer" }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>📤</div>
            <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>导入数据</h3>
            <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>
              上传 Excel / Word / PDF 文件，使用规则解析为结构化运单
            </p>
          </div>
        </Link>
        <Link href="/rules" style={{ textDecoration: "none" }}>
          <div className="card" style={{ padding: 28, cursor: "pointer" }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>⚙️</div>
            <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>规则管理</h3>
            <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>
              创建、编辑解析规则，或上传文件由 AI 自动生成推荐规则
            </p>
          </div>
        </Link>
      </div>

      {/* Workflow Guide */}
      <div className="card">
        <div className="card-header">
          <h3 style={{ fontSize: 15, fontWeight: 600 }}>使用流程</h3>
          <span className="badge badge-primary">引导</span>
        </div>
        <div className="card-body">
          <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
            {[
              { step: 1, title: "上传文件", desc: "拖拽或点击上传出库单文件" },
              { step: 2, title: "选择/创建规则", desc: "选择已有规则或让AI自动分析生成" },
              { step: 3, title: "预览编辑", desc: "检查解析结果，在线编辑修正" },
              { step: 4, title: "提交下单", desc: "校验通过后提交到数据库" },
            ].map((item) => (
              <div key={item.step} style={{ flex: 1, textAlign: "center", padding: "12px 8px" }}>
                <div style={{
                  width: 36, height: 36, borderRadius: "50%", background: "var(--primary)",
                  color: "white", display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 16, fontWeight: 700, margin: "0 auto 8px"
                }}>
                  {item.step}
                </div>
                <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>{item.title}</div>
                <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>{item.desc}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
