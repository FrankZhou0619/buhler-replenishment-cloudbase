export const arimsFields = [
  ['customerNumber', '客户编号'], ['customerName', '客户名称'], ['exportDateTime', '导出时间'],
  ['siteNumber', '站点编号'], ['siteName', '站点名称'], ['freetext', '站点备注'],
  ['locationName', '位置名称'], ['customerItemNumber', '客户物料号'], ['customerItemFreetext', '客户物料备注'],
  ['supplierNumber', '供应商编号'], ['supplierName', '供应商名称'], ['supplierItemNumber', '供应商物料号'],
  ['project', '所属项目'], ['description', '物料描述'], ['dimension', '规格'], ['unit', '单位'],
  ['price', '价格'], ['pricePer', '计价数量'], ['currency', '币种'], ['yearlyUsage', '年用量'],
  ['reorderQuantity', '标准补料数量'], ['reorderPoint', '补料点'], ['bin', '料盒编号'],
  ['physicalAddress', '实体库位'], ['orderState', '未结订单状态'], ['orderQuantity', '未结订单数量'],
  ['orderDateTime', '下单时间'], ['deliveryDateTime', '计划交付时间'], ['orderNumber', '未结订单号'],
  ['orderPosition', '订单行号'], ['stockAmount', '库存数量'], ['stockInDays', '可用天数'],
  ['stockValue', '库存价值'], ['lastReceived', '库存最后更新时间'],
] as const;
export type ArimsRow = Record<string, string>;
export type ArimsResult = {
  ok: boolean; code?: string; error?: string; token?: string; permissions?: string[];
  method?: string; url?: string; requestSummary?: string; elapsedMs?: number;
  upstreamStatus?: number; upstreamHeaders?: Record<string, string>; responseBody?: string; sizeBytes?: number;
};
const known = new Set(arimsFields.map(([key]) => key));
function descendants(element: Element, name: string) {
  return Array.from(element.getElementsByTagName('*')).filter(child => child.localName === name);
}
export function parseArimsXml(xml: string, Parser: typeof DOMParser = DOMParser): { rows: ArimsRow[]; root: string } {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('此调试页不解析包含 DTD 或实体声明的 XML。');
  const doc = new Parser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length || !doc.documentElement) throw new Error('响应不是格式正确的 XML，请查看原始响应。');
  const root = doc.documentElement;
  if (root.localName.toLowerCase() === 'html') throw new Error('收到的是 HTML 页面，请核对接口地址和登录状态。');
  const all = Array.from(doc.getElementsByTagName('*'));
  const marker = ['customerItemNumber', 'supplierItemNumber', 'physicalAddress', 'stockAmount'].find(name => all.some(node => node.localName === name));
  if (!marker) return { rows: [], root: root.localName };
  const candidates = new Set<Element>();
  for (const leaf of all.filter(node => node.localName === marker)) {
    let candidate: Element | null = leaf.parentElement;
    while (candidate) {
      const fields = Array.from(candidate.getElementsByTagName('*')).filter(node => known.has(node.localName as typeof arimsFields[number][0]));
      if (new Set(fields.map(field => field.localName)).size >= 3 || !candidate.parentElement) break;
      const parent: Element = candidate.parentElement;
      if (descendants(parent, marker).length > 1) break;
      candidate = parent;
    }
    if (candidate) candidates.add(candidate);
  }
  const rows = Array.from(candidates).map(record => {
    const row: ArimsRow = {};
    for (const [key] of arimsFields) {
      let value = descendants(record, key)[0]?.textContent?.trim();
      if (value === undefined) {
        let parent = record.parentElement;
        while (parent) {
          const field = Array.from(parent.children).find(child => child.localName === key);
          if (field) { value = field.textContent?.trim() || ''; break; }
          parent = parent.parentElement;
        }
      }
      row[key] = value || '';
    }
    return row;
  });
  return { rows, root: root.localName };
}
export function arimsCsv(rows: ArimsRow[]) {
  const escape = (value: string) => '"' + (/^[=+\-@\t\r]/.test(value) ? "'" + value : value).replaceAll('"', '""') + '"';
  return '\ufeff' + [arimsFields.map(([key, label]) => `${label} (${key})`), ...rows.map(row => arimsFields.map(([key]) => row[key] || ''))].map(row => row.map(escape).join(',')).join('\r\n');
}
export const ARIMS_SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<stocklist>
  <customerNumber>DEMO</customerNumber><customerName>示例客户 · 虚构数据</customerName>
  <exportDateTime>2026-11-05T10:00:00.000+08:00</exportDateTime>
  <site><siteNumber>DEMO-SITE</siteNumber><siteName>示例线边仓</siteName><items>
    <item><customerItemNumber>DEMO-001</customerItemNumber><description>示例内六角螺钉</description><dimension>M 6 × 16</dimension><physicalAddress>1/10</physicalAddress><bin>1010</bin><stockAmount>240</stockAmount><reorderQuantity>700</reorderQuantity><unit>PCS</unit></item>
    <item><customerItemNumber>DEMO-002</customerItemNumber><description>示例六角螺母</description><dimension>M 8</dimension><physicalAddress>2/20</physicalAddress><bin>2020</bin><stockAmount>80</stockAmount><reorderQuantity>500</reorderQuantity><unit>PCS</unit></item>
    <item><customerItemNumber>DEMO-003</customerItemNumber><description>示例平垫圈</description><dimension>8.4 × 16</dimension><physicalAddress>5/19</physicalAddress><bin>5019</bin><stockAmount>1200</stockAmount><reorderQuantity>1000</reorderQuantity><unit>PCS</unit></item>
  </items></site>
</stocklist>`;
