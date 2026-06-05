// ===== 全局状态管理 =====
// 支持 localStorage 持久化 + API 数据库同步

import type { ParseRule, ParsedOrder } from "./types";

const STORAGE_KEYS = {
  RULES: "ui_v2_rules",
  ORDERS: "ui_v2_orders",
} as const;

// ----- 规则管理 -----
export function getRules(): ParseRule[] {
  if (typeof window === "undefined") return [];
  try {
    const data = localStorage.getItem(STORAGE_KEYS.RULES);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

export function saveRule(rule: ParseRule): { success: boolean; error?: string } {
  const rules = getRules();
  
  // 同名检查
  const duplicate = rules.find((r) => r.name === rule.name && r.id !== rule.id);
  if (duplicate) {
    return { success: false, error: `规则"${rule.name}"已存在` };
  }
  
  const idx = rules.findIndex((r) => r.id === rule.id);
  if (idx >= 0) {
    rules[idx] = { ...rule, updatedAt: new Date().toISOString() };
  } else {
    rules.push(rule);
  }
  localStorage.setItem(STORAGE_KEYS.RULES, JSON.stringify(rules));
  return { success: true };
}

export function checkRuleNameDuplicate(name: string, excludeId?: string): boolean {
  const rules = getRules();
  return rules.some((r) => r.name === name && r.id !== excludeId);
}

export function deleteRule(id: string): void {
  const rules = getRules().filter((r) => r.id !== id);
  localStorage.setItem(STORAGE_KEYS.RULES, JSON.stringify(rules));
}

export function getRule(id: string): ParseRule | undefined {
  return getRules().find((r) => r.id === id);
}

// ----- 运单管理 -----
export function getOrders(): ParsedOrder[] {
  if (typeof window === "undefined") return [];
  try {
    const data = localStorage.getItem(STORAGE_KEYS.ORDERS);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

export function saveOrders(orders: ParsedOrder[]): { success: boolean; count: number } {
  const existing = getOrders();
  const combined = [...existing, ...orders];
  localStorage.setItem(STORAGE_KEYS.ORDERS, JSON.stringify(combined));
  return { success: true, count: orders.length };
}

export function clearCurrentOrders(): void {
  localStorage.removeItem("ui_v2_current_orders");
}

export function getCurrentOrders(): ParsedOrder[] {
  if (typeof window === "undefined") return [];
  try {
    const data = localStorage.getItem("ui_v2_current_orders");
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

export function setCurrentOrders(orders: ParsedOrder[]): void {
  localStorage.setItem("ui_v2_current_orders", JSON.stringify(orders));
}

// ----- ID 生成 -----
export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}
