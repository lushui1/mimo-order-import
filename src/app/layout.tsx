import type { Metadata } from "next";
import "./globals.css";
import Sidebar from "@/components/Sidebar";
import { ToastProvider } from "@/components/ToastProvider";

export const metadata: Metadata = {
  title: "万能导入 V2 - 智能批量下单系统",
  description: "AI驱动智能多格式批量下单系统",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>
        <div style={{ display: "flex" }}>
          <Sidebar />
          <main style={{ flex: 1, padding: "24px 32px", minHeight: "100vh" }}>
            <ToastProvider>
              {children}
            </ToastProvider>
          </main>
        </div>
      </body>
    </html>
  );
}
