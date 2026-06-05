import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: "50mb",
    },
  },
  // 增加服务端函数超时时间（Vercel hobby 默认10s，AI reasoning 模型需要更长时间）
  serverExternalPackages: ["pdfjs-dist"],
};

export default nextConfig;
