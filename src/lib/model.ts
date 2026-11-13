export type Item = { L: string; M: string; N: string; BI: string; BX: string; row: number };
export type RackCell = { location: string; col: number; span: number; row: number; rowSpan: number; sourceRow?: number };
export type Rack = { rack: number; cells: RackCell[] };
export type BoardConfig = {
  catalog: Item[];
  layout: Rack[];
  referenceImage: string;
  layoutRevision: number;
  layoutSource: string;
};
export type Bin = { location: string; status: 'full' | 'pending'; revision: number; marked_at: string | null; updated_at: string; updated_by: string; request_id: string | null; reported_by_uid?: string | null };
export const fullBin = (location: string): Bin => ({ location, status: 'full', revision: 0, marked_at: null, updated_at: '', updated_by: '', request_id: null });
export type MailDelivery = { recipient: string; status: string; error: string | null; sent_at: string | null };
export type Order = { id: string; created_at: string; created_by: string; items: Item[]; status: string; recipient: string; error: string | null; sent_at: string | null; completed_count: number; deliveries?: MailDelivery[] };
export type Event = { id: string; action: string; location: string; created_at: string; operator: string; detail: string };
export type Snapshot = { bins: Bin[]; orders: Order[]; events: Event[]; recipients: string; mailReady: boolean; mailTokenConfigured: boolean; mailFrom: string; mailFromName: string; serverTime: string; todayCompleted: number; layoutRevision?: number; board?: BoardConfig };
export const columns = ['L', 'M', 'N', 'BI', 'BX'] as const;
export const headings = ['客户物料号 (L)', '物料描述 (M)', '规格 (N)', '补料数量 (BI)', '料盒位置 (BX)'];
const safeCell = (v: unknown) => {
  const s = String(v ?? '');
  return '"' + (/^[=+@\-\t\r]/.test(s) ? "'" + s : s).replaceAll('"', '""') + '"';
};
export function csv(items: Item[]) {
  return '\ufeff' + [headings, ...items.map(i => columns.map(k => i[k]))].map(row => row.map(safeCell).join(',')).join('\r\n');
}
export function mailText(order: Pick<Order, 'id' | 'items' | 'created_at' | 'created_by'>) {
  return `Bühler Wuxi 线边仓补料清单\n单号：${order.id}\n创建时间：${order.created_at}\n巡检人员：${order.created_by}\n共 ${order.items.length} 个料盒需要补料。请按库位拣料并在终端确认补满。\n\n` +
    order.items.map(i => `库位 (BX)：${i.BX}\n客户物料号 (L)：${i.L}\n物料描述 (M)：${i.M}\n规格 (N)：${i.N}\n补料数量 (BI)：${i.BI}`).join('\n\n') +
    '\n\n说明：补料数量读取原表 BI（Reorder QTY / Used），不是实时库存。合并库位按一个料盒计入。';
}
