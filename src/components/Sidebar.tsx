"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/", label: "首页", icon: "📊" },
  { href: "/upload", label: "导入数据", icon: "📤" },
  { href: "/rules", label: "规则管理", icon: "⚙️" },
  { href: "/preview", label: "数据预览", icon: "📋" },
  { href: "/history", label: "运单记录", icon: "📦" },
];

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="sidebar">
      <div className="sidebar-logo">
        <span style={{ fontSize: 24 }}>🐋</span>
        <span>万能导入 V2</span>
      </div>
      <nav className="sidebar-nav">
        {navItems.map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn("sidebar-item", isActive && "active")}
            >
              <span>{item.icon}</span>
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
      <div style={{ padding: "16px 20px", borderTop: "1px solid var(--border)" }}>
        <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
          智能解析 · 规则引擎
        </div>
        <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 4 }}>
          支持 Excel / Word / PDF
        </div>
      </div>
    </aside>
  );
}
