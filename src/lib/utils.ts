// ===== UI 工具函数 =====
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function validatePhone(phone: string): boolean {
  return /^1[3-9]\d{9}$/.test(phone);
}

export function validateRequired(val: string | undefined | null): boolean {
  return !!val && val.trim().length > 0;
}

export function validateNumberPositive(val: number | undefined | null): boolean {
  return val !== undefined && val !== null && val > 0;
}
