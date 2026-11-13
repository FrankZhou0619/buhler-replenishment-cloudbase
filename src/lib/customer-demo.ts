import type { Item, Rack } from './model';

export const demoRoles = {
  worker: { label: '现场工人', description: '报缺并撤销本人未下发的需求。', request: true, dispatch: false, refill: false, plan: false },
  lead: { label: '布勒线长', description: '巡检报缺、处理未下发的误报，并下发需求。', request: true, dispatch: true, refill: false, plan: false },
  refill: { label: 'Bossard 补料员', description: '核对已下发需求，按样例可用库存确认补入。', request: false, dispatch: false, refill: true, plan: false },
  admin: { label: '项目管理员', description: '演示完整流程，包括采购与计划的数据导入。', request: true, dispatch: true, refill: true, plan: true }
} as const;

export type DemoRole = keyof typeof demoRoles;
export type BinAction = 'request' | 'cancel' | 'dispatch' | 'refill';
export type DemoRequest = { owner: DemoRole; quantity: number; dispatched: boolean };
export type DemoInventory = { stock: Map<string, number>; requests: Map<string, DemoRequest> };
export type UsageRow = { period: string; material: string; forecast: number; actual: number | null };
export type BomRow = { model: string; material: string; perUnit: number };

export const usageHeaders = ['期间', '客户物料号', '预测量', '实际用量'];
export const bomHeaders = ['样机型号', '客户物料号', '单台用量'];
export const materialKey = (code: string) => code.normalize('NFKC').trim().toUpperCase();
export const standardQuantity = (item: Item) => Number(item.BI);

export const stockStatuses = {
  enough: { label: '可补足', symbol: '✓', tone: 'enough' },
  partial: { label: '部分可补', symbol: '½', tone: 'partial' },
  empty: { label: '无库存', symbol: '×', tone: 'empty' },
  unknown: { label: '未获取', symbol: '?', tone: 'unknown' }
} as const;

export function stockStatus(available: number | undefined, quantity: number) {
  if (available === undefined) return stockStatuses.unknown;
  if (available === 0) return stockStatuses.empty;
  return available < quantity ? stockStatuses.partial : stockStatuses.enough;
}

export function makeDemoSamples(catalog: Item[], racks: Rack[]) {
  const byLocation = new Map(catalog.map(item => [item.BX, item]));
  const seen = new Set<string>();
  const items: Item[] = [];
  for (const rack of racks) {
    let count = 0;
    for (const cell of rack.cells) {
      const item = byLocation.get(cell.location);
      if (!item || standardQuantity(item) < 2 || seen.has(materialKey(item.L))) continue;
      seen.add(materialKey(item.L));
      items.push(item);
      if (++count === 6) break;
    }
  }

  const stock = new Map<string, number>();
  const requests = new Map<string, DemoRequest>();
  items.forEach((item, index) => {
    const quantity = standardQuantity(item);
    if (index !== 3) stock.set(materialKey(item.L), index === 2 ? 0 : index === 1 ? Math.floor(quantity / 2) : quantity * 2);
    if (index < 4) requests.set(item.BX, { owner: index === 1 ? 'lead' : 'worker', quantity, dispatched: index === 0 });
  });

  const usage = items.slice(0, 5).map((item, index): UsageRow => {
    const forecast = index === 4 ? 0 : standardQuantity(item);
    const ratio = [1.4, 0.65, 1.05][index];
    const actual = index === 3 ? null : index === 4 ? 30 : Math.round(forecast * ratio);
    return { period: '2026-11', material: item.L, forecast, actual };
  });
  const bom = items.slice(0, 4).map((item, index): BomRow => ({
    model: '样机 A', material: item.L, perUnit: Math.max(1, Math.floor(standardQuantity(item) / (index === 0 ? 12 : 3)))
  }));
  bom.push({ model: '样机 A', material: 'NEW-DEMO-01', perUnit: 4 });
  return { inventory: { stock, requests } satisfies DemoInventory, usage, bom };
}

export function canChangeBin(role: DemoRole, action: BinAction, request: DemoRequest | undefined, available: number | undefined) {
  const permission = demoRoles[role];
  switch (action) {
    case 'request': return permission.request && !request;
    case 'cancel': return Boolean(request && !request.dispatched && (permission.dispatch || request.owner === role));
    case 'dispatch': return Boolean(permission.dispatch && request && !request.dispatched);
    case 'refill': return Boolean(permission.refill && request?.dispatched && available && available > 0);
  }
}

export function changeDemoBin(inventory: DemoInventory, role: DemoRole, action: BinAction, item: Item) {
  const request = inventory.requests.get(item.BX);
  const material = materialKey(item.L);
  const available = inventory.stock.get(material);
  if (!canChangeBin(role, action, request, available)) return inventory;

  const requests = new Map(inventory.requests);
  if (action === 'request') requests.set(item.BX, { owner: role, quantity: standardQuantity(item), dispatched: false });
  if (action === 'cancel') requests.delete(item.BX);
  if (action === 'dispatch' && request) requests.set(item.BX, { ...request, dispatched: true });
  if (action === 'refill' && request && available !== undefined) {
    const quantity = Math.min(request.quantity, available);
    const remaining = request.quantity - quantity;
    if (remaining) requests.set(item.BX, { ...request, quantity: remaining });
    else requests.delete(item.BX);
    return { requests, stock: new Map(inventory.stock).set(material, available - quantity) };
  }
  return { ...inventory, requests };
}

function checkedRows(rows: string[][], headers: string[]) {
  if (!headers.every((heading, index) => rows[0]?.[index] === heading)) {
    throw new Error(`请使用本页模板，首行列名为 ${headers.join('、')}。`);
  }
  const data = rows.slice(1).map((cells, index) => ({ cells, line: index + 2 })).filter(row => row.cells.some(Boolean));
  if (!data.length || data.length > 500) throw new Error('请在模板中填写 1–500 条记录。');
  return data;
}

function quantity(value: string, line: number, field: string, minimum = 0) {
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < minimum || number > 1_000_000_000) {
    throw new Error(`第 ${line} 行的${field}须为 ${minimum}–1,000,000,000 之间的整数。`);
  }
  return number;
}

export function parseUsageRows(rows: string[][]): UsageRow[] {
  const keys = new Set<string>();
  return checkedRows(rows, usageHeaders).map(({ cells: [period, material, forecast, actual], line }) => {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period) || !material || material.length > 100) {
      throw new Error(`第 ${line} 行须填写 YYYY-MM 格式的期间和客户物料号。`);
    }
    const key = period + ':' + materialKey(material);
    if (keys.has(key)) throw new Error(`第 ${line} 行的期间和物料号重复，请先汇总。`);
    keys.add(key);
    return { period, material, forecast: quantity(forecast, line, '预测量'), actual: actual ? quantity(actual, line, '实际用量') : null };
  });
}

export function parseBomRows(rows: string[][]): BomRow[] {
  return checkedRows(rows, bomHeaders).map(({ cells: [model, material, perUnit], line }) => {
    if (!model || !material || model.length > 100 || material.length > 100) {
      throw new Error(`第 ${line} 行须填写样机型号和客户物料号，每项最多 100 字。`);
    }
    return { model, material, perUnit: quantity(perUnit, line, '单台用量', 1) };
  });
}

export function usageDeviation(row: UsageRow, threshold: number) {
  if (row.actual === null) return { difference: null, rate: null, status: '暂无实绩', alert: false };
  const difference = row.actual - row.forecast;
  if (row.forecast === 0) {
    return { difference, rate: null, status: difference ? '零预测有用量' : '正常', alert: difference > 0 };
  }
  const rate = difference * 100 / row.forecast;
  const alert = Math.abs(rate) > threshold;
  return { difference, rate, status: alert ? (rate > 0 ? '用量超预期' : '用量低于预期') : '正常', alert };
}

export function aggregateBom(rows: BomRow[], model: string, units: number) {
  const totals = new Map<string, { material: string; needed: number }>();
  for (const row of rows) {
    if (row.model !== model) continue;
    const key = materialKey(row.material);
    const needed = (totals.get(key)?.needed ?? 0) + row.perUnit * units;
    totals.set(key, { material: row.material, needed });
  }
  return [...totals.values()];
}
