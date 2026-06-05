// ===== 全局状态管理 =====
// 支持 localStorage 持久化 + API 数据库同步

import type { ParseRule, ParsedOrder } from "./types";

const STORAGE_KEYS = {
  RULES: "ui_v2_rules",
  ORDERS: "ui_v2_orders",
} as const;

// ----- 规则管理（localStorage 本地缓存）-----
export function getRules(): ParseRule[] {
  if (typeof window === "undefined") return [];
  try {
    const data = localStorage.getItem(STORAGE_KEYS.RULES);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

export function saveRule(rule: ParseRule): { success: boolean; error?: string; reused?: boolean } {
  const rules = getRules();
  
  // 去重复用：检查是否有完全相同列映射的规则（sourceField+targetField 完全一致）
  // 如果生成的规则与已有规则映射一致，直接复用已有规则，不报错
  const duplicateByName = rules.find((r) => r.name === rule.name && r.id !== rule.id);
  if (duplicateByName) {
    // 同名规则：检查列映射是否一致
    const sameMappings = isSameMappings(duplicateByName.columnMappings, rule.columnMappings);
    if (sameMappings) {
      // 映射一致 → 直接复用，不报错
      return { success: true, reused: true };
    }
    // 同名但映射不同 → 改名后保存
    rule = { ...rule, name: `${rule.name} (${new Date().toLocaleTimeString()})` };
  }
  
  const idx = rules.findIndex((r) => r.id === rule.id);
  if (idx >= 0) {
    rules[idx] = { ...rule, updatedAt: new Date().toISOString() };
  } else {
    rules.push(rule);
  }
  localStorage.setItem(STORAGE_KEYS.RULES, JSON.stringify(rules));
  
  // 同时同步到服务端
  syncRuleToServer(rule);
  
  return { success: true };
}

// 检查两组列映射是否语义一致
function isSameMappings(a: ParseRule["columnMappings"], b: ParseRule["columnMappings"]): boolean {
  if (a.length !== b.length) return false;
  const keyOf = (m: ParseRule["columnMappings"][0]) => `${m.sourceField}→${m.targetField}`;
  const aKeys = new Set(a.map(keyOf));
  const bKeys = b.map(keyOf);
  return bKeys.every(k => aKeys.has(k));
}

export function checkRuleNameDuplicate(name: string, excludeId?: string): boolean {
  const rules = getRules();
  return rules.some((r) => r.name === name && r.id !== excludeId);
}

export function deleteRule(id: string): void {
  const rules = getRules().filter((r) => r.id !== id);
  localStorage.setItem(STORAGE_KEYS.RULES, JSON.stringify(rules));
  deleteRuleFromServer(id);
}

export function getRule(id: string): ParseRule | undefined {
  return getRules().find((r) => r.id === id);
}

// ----- 规则服务端同步 -----
async function syncRuleToServer(rule: ParseRule): Promise<void> {
  try {
    await fetch("/api/rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rule),
    });
  } catch (e) {
    console.warn("[store] Failed to sync rule to server:", e);
  }
}

async function deleteRuleFromServer(id: string): Promise<void> {
  try {
    await fetch(`/api/rules?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  } catch (e) {
    console.warn("[store] Failed to delete rule from server:", e);
  }
}

export async function syncRulesFromServer(rules: ParseRule[]): Promise<ParseRule[]> {
  try {
    const res = await fetch("/api/rules");
    if (res.ok) {
      const data = await res.json();
      if (data.rules && data.rules.length > 0) {
        // Merge: server rules take priority, deduplicate by id
        const serverIds = new Set(data.rules.map((r: ParseRule) => r.id));
        const merged = [...data.rules, ...rules.filter(r => !serverIds.has(r.id))];
        localStorage.setItem(STORAGE_KEYS.RULES, JSON.stringify(merged));
        return merged;
      }
    }
  } catch (e) {
    console.warn("[store] Failed to sync rules from server:", e);
  }
  return rules;
}

// ===== 运单管理 -----
// 当前解析结果的临时存储（页面跳转用）
const CURRENT_KEY = "ui_v2_current_orders";

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
  if (typeof window !== "undefined") {
    localStorage.removeItem(CURRENT_KEY);
  }
}

export function getCurrentOrders(): ParsedOrder[] {
  if (typeof window === "undefined") return [];
  try {
    const data = localStorage.getItem(CURRENT_KEY);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

export function setCurrentOrders(orders: ParsedOrder[]): void {
  if (typeof window !== "undefined") {
    localStorage.setItem(CURRENT_KEY, JSON.stringify(orders));
  }
}

// ----- ID 生成 -----
export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}
