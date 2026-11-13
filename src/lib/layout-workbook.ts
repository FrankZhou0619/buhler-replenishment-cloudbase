import JSZip from '../vendor/jszip.min.js';
import { normalizeLocation, validateCatalog } from '../../shared/board-layout.mjs';
import type { Item, Rack } from './model';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_XML_BYTES = 6 * 1024 * 1024;
const SHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const DOCUMENT_RELS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
type Row = { number: number; values: Map<string, string> };
export type ImportedWorkbook = { catalog: Item[]; layout?: Rack[]; source: string };

function children(parent: Pick<ParentNode, 'children'>, name: string) {
  return Array.from(parent.children).filter(el => el.localName === name);
}

async function readXml(zip: JSZip, path: string) {
  const part = zip.file(path);
  if (!part) throw new Error('Excel 文件缺少必要的工作表数据。');
  const text = await new Promise<string>((resolve, reject) => {
    const stream = part.internalStream('uint8array');
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    let size = 0;
    stream.on('data', bytes => {
      size += bytes.byteLength;
      if (size > MAX_XML_BYTES) {
        stream.pause();
        reject(new Error('Excel 工作表解压后过大，请保留导入所需的列和行。'));
      } else chunks.push(decoder.decode(bytes, { stream: true }));
    }).on('error', reject).on('end', () => {
      chunks.push(decoder.decode());
      resolve(chunks.join(''));
    }).resume();
  });
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('Excel 包含不受支持的 XML 定义。');
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Excel 的工作表内容无法读取。');
  return doc;
}

function cellText(element: Element) {
  const simple = children(element, 't').map(el => el.textContent || '');
  const rich = children(element, 'r').flatMap(r => children(r, 't').map(el => el.textContent || ''));
  return [...simple, ...rich].join('');
}

function readRows(doc: XMLDocument, strings: string[]) {
  const rows = Array.from(doc.getElementsByTagNameNS(SHEET_NS, 'row'));
  if (rows.length > 20_000) throw new Error('工作表行数过多，请仅保留需要导入的物料和布局。');
  return rows.map((row, index): Row => {
    const values = new Map<string, string>();
    for (const cell of children(row, 'c')) {
      const key = cell.getAttribute('r')?.match(/^[A-Z]+/)?.[0];
      if (!key) continue;
      const type = cell.getAttribute('t');
      const value = children(cell, 'v')[0]?.textContent ?? '';
      if (type === 's') values.set(key, value === '' ? '' : strings[Number(value)] ?? '');
      else if (type === 'inlineStr') {
        const rich = children(cell, 'is')[0];
        values.set(key, rich ? cellText(rich) : '');
      } else if (type !== 'e' && type !== 'b') values.set(key, value);
    }
    return { number: Number(row.getAttribute('r')) || index + 1, values };
  });
}

const key = (v: string) => v.normalize('NFKC').trim().toLowerCase().replace(/[\s.()_-]+/g, '');
const MATERIAL_HEADERS = {
  BX: ['BX', '库位', '料盒位置', '料盒位置 (BX)', 'Phys. Addr.'],
  L: ['L', '客户物料号', '客户物料号 (L)', 'Customer Item No.'],
  M: ['M', '物料描述', '物料描述 (M)', 'Description'],
  N: ['N', '规格', '规格 (N)', 'Dimension'],
  BI: ['BI', '补料数量', '补料数量 (BI)', 'Reorder Quantity', 'Reorder QTY']
};
const PLACEMENT_HEADERS = {
  BX: MATERIAL_HEADERS.BX,
  rack: ['货架', '货架号', 'Rack'],
  row: ['层', '层号', 'Row', 'Shelf'],
  col: ['列', '列号', 'Col', 'Column'],
  span: ['跨列', '跨列数', 'ColSpan', 'Span'],
  rowSpan: ['跨层', '跨层数', 'RowSpan']
};

function findHeaders<K extends string>(rows: Row[], aliases: Record<K, string[]>, required: K[]) {
  const fields = Object.keys(aliases) as K[];
  for (const [index, row] of rows.slice(0, 35).entries()) {
    const header = new Map([...row.values].map(([col, value]) => [key(value), col]));
    const cols = {} as Partial<Record<K, string>>;
    for (const field of fields) {
      cols[field] = aliases[field].map(alias => header.get(key(alias))).find(Boolean);
    }
    if (required.every(field => cols[field])) return { cols, index };
  }
  return null;
}

function materialRows(rows: Row[]) {
  const fields = Object.keys(MATERIAL_HEADERS) as (keyof typeof MATERIAL_HEADERS)[];
  // The original ARIMS workbook contains multiple "Used" headings.
  // Read BI by column only after identifying the full export's fixed headers.
  const original = rows.slice(0, 35).findIndex(({ values }) =>
    ['L', 'M', 'N', 'BI', 'BX'].map(col => key(values.get(col) || '')).join('|') ===
    'customeritemno|description|dimension|used|physaddr'
  );
  const match = original >= 0
    ? { index: original, cols: { L: 'L', M: 'M', N: 'N', BI: 'BI', BX: 'BX' } }
    : findHeaders(rows, MATERIAL_HEADERS, fields);
  if (!match) throw new Error('找不到物料表表头。请使用原始 Master 导出表，或填写 BX、L、M、N、BI 五列表头。');
  const items = rows.slice(match.index + 1).flatMap(row => {
    const values = fields.map(field => row.values.get(match.cols[field] || '')?.trim() || '');
    if (values.every(v => !v)) return [];
    return [{ ...Object.fromEntries(fields.map((field, i) => [field, values[i]])), row: row.number }];
  });
  return validateCatalog(items);
}

function placementRows(rows: Row[]) {
  const match = findHeaders<keyof typeof PLACEMENT_HEADERS>(rows, PLACEMENT_HEADERS, ['BX', 'row', 'col']);
  if (!match) throw new Error('货架布局表至少需要 BX、层、列三个表头。');
  const groups = new Map<number, Rack>();
  for (const row of rows.slice(match.index + 1)) {
    const read = (field: keyof typeof PLACEMENT_HEADERS) => row.values.get(match.cols[field] || '')?.trim() || '';
    const location = read('BX');
    const numbers = [read('rack'), read('row'), read('col'), read('span'), read('rowSpan')];
    if (!location && numbers.every(v => !v)) continue;
    const rack = Number(numbers[0] || normalizeLocation(location).split('/')[0]);
    if (!groups.has(rack)) groups.set(rack, { rack, cells: [] });
    groups.get(rack)!.cells.push({
      location, row: Number(numbers[1]), col: Number(numbers[2]), span: Number(numbers[3] || 1),
      rowSpan: Number(numbers[4] || 1), sourceRow: row.number
    });
  }
  return [...groups.values()];
}

async function openWorkbook(file: File) {
  if (!/\.xlsx$/i.test(file.name) || !file.size || file.size > MAX_FILE_BYTES) {
    throw new Error('请选择 10 MB 以内的 .xlsx 文件。');
  }
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(await file.arrayBuffer()); }
  catch { throw new Error('无法打开 Excel，请确认文件是未加密的 .xlsx 格式。'); }
  const [workbook, relationships, shared] = await Promise.all([
    readXml(zip, 'xl/workbook.xml'), readXml(zip, 'xl/_rels/workbook.xml.rels'),
    zip.file('xl/sharedStrings.xml') ? readXml(zip, 'xl/sharedStrings.xml') : null
  ]);
  const targets = new Map(Array.from(relationships.getElementsByTagNameNS(PACKAGE_RELS, 'Relationship'))
    .filter(el => el.getAttribute('TargetMode') !== 'External')
    .map(el => [el.getAttribute('Id'), el.getAttribute('Target') || '']));
  const sheets = Array.from(workbook.getElementsByTagNameNS(SHEET_NS, 'sheet')).map(el => ({
    name: (el.getAttribute('name') || '').trim(),
    path: new URL(targets.get(el.getAttributeNS(DOCUMENT_RELS, 'id')) || '', 'https://package.invalid/xl/workbook.xml').pathname.slice(1)
  })).filter(({ path }) => /^xl\/worksheets\/[^/]+\.xml$/i.test(path));
  const strings = shared ? Array.from(shared.getElementsByTagNameNS(SHEET_NS, 'si')).map(cellText) : [];
  return { zip, sheets, strings };
}

export async function readFirstWorksheet(file: File, columns: readonly string[]): Promise<string[][]> {
  const { zip, sheets, strings } = await openWorkbook(file);
  if (!sheets.length) throw new Error('Excel 中找不到工作表。');
  const rows = readRows(await readXml(zip, sheets[0].path), strings);
  return rows.map(row => columns.map(column => row.values.get(column)?.trim() ?? ''));
}

export async function readLayoutWorkbook(file: File): Promise<ImportedWorkbook> {
  const { zip, sheets, strings } = await openWorkbook(file);
  const geometry = sheets.find(s => ['货架布局', 'layout'].includes(s.name.toLowerCase()));
  const material = ['物料', '物料表', 'Master'].map(name => sheets.find(s => s.name === name)).find(Boolean) ||
    sheets.find(s => s !== geometry);
  if (!material) throw new Error('Excel 中找不到物料工作表。');
  const materialDoc = await readXml(zip, material.path);
  const catalog = materialRows(readRows(materialDoc, strings));
  const layout = geometry ? placementRows(readRows(await readXml(zip, geometry.path), strings)) : undefined;
  return { catalog, layout, source: file.name };
}

function xmlText(value: string) {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\r', '&#13;');
}

type Sheet = { name: string; rows: (string | number)[][]; widths: number[]; textColumns?: number[] };

function worksheet({ rows, widths, textColumns = [] }: Sheet) {
  const text = new Set(textColumns);
  const columns = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"${text.has(i) ? ' style="1"' : ''}/>`).join('');
  const data = rows.map((row, i) => {
    const cells = row.map((value, j) => {
      const ref = String.fromCharCode(65 + j) + (i + 1);
      if (typeof value === 'number') return `<c r="${ref}"><v>${value}</v></c>`;
      return `<c r="${ref}" t="inlineStr"${text.has(j) ? ' s="1"' : ''}><is><t xml:space="preserve">${xmlText(value)}</t></is></c>`;
    }).join('');
    return `<row r="${i + 1}">${cells}</row>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${SHEET_NS}"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${columns}</cols><sheetData>${data}</sheetData></worksheet>`;
}

// Built-in number format 49 keeps editable periods and material numbers as text.
const textColumnStyles = `<styleSheet xmlns="${SHEET_NS}">
  <fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
  <borders count="1"><border/></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="2">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

export async function exportWorkbook(sheets: Sheet[]) {
  const zip = new JSZip();
  const sheetRels = sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${DOCUMENT_RELS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('');
  const sheetTypes = sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');
  const hasTextColumns = sheets.some(sheet => sheet.textColumns?.length);
  const styleRel = hasTextColumns ? `<Relationship Id="rId${sheets.length + 1}" Type="${DOCUMENT_RELS}/styles" Target="styles.xml"/>` : '';
  const styleType = hasTextColumns ? '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' : '';
  if (hasTextColumns) zip.file('xl/styles.xml', textColumnStyles);
  zip.file('[Content_Types].xml', `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheetTypes}${styleType}</Types>`);
  zip.file('_rels/.rels', `<Relationships xmlns="${PACKAGE_RELS}"><Relationship Id="rId1" Type="${DOCUMENT_RELS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file('xl/workbook.xml', `<workbook xmlns="${SHEET_NS}" xmlns:r="${DOCUMENT_RELS}"><bookViews><workbookView/></bookViews><sheets>${sheets.map(({ name }, i) => `<sheet name="${xmlText(name).replaceAll('"', '&quot;')}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<Relationships xmlns="${PACKAGE_RELS}">${sheetRels}${styleRel}</Relationships>`);
  sheets.forEach((sheet, i) => {
    zip.file(`xl/worksheets/sheet${i + 1}.xml`, worksheet(sheet));
  });
  return zip.generateAsync({
    type: 'blob', compression: 'DEFLATE',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  });
}

export function exportLayoutWorkbook(catalog: Item[], layout: Rack[]) {
  return exportWorkbook([
    { name: '物料', rows: [
      ['BX', 'L', 'M', 'N', 'BI'], ...catalog.map(item => [item.BX, item.L, item.M, item.N, Number(item.BI)])
    ], widths: [15, 23, 54, 28, 14] },
    { name: '货架布局', rows: [
      ['BX', '货架', '层', '列', '跨列', '跨层'],
      ...layout.flatMap(r => r.cells.map(c => [c.location, r.rack, c.row, c.col, c.span, c.rowSpan]))
    ], widths: [15, 12, 10, 10, 10, 10] }
  ]);
}
