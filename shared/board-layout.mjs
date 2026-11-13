export const MAX_LAYOUT_ITEMS = 600;
export const MAX_LAYOUT_RACKS = 40;
export const MAX_SHELF_ROWS = 20;
export const GRID_COLUMNS = 12;
export const MAX_LAYOUT_BYTES = 200 * 1024;
export const AUTO_ROW_OPTIONS = [3, 4, 6];

export class LayoutError extends Error {
  constructor(issues) {
    super(issues[0] || '布局配置无效。');
    this.name = 'LayoutError';
    this.issues = issues;
  }
}

function locationParts(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().replaceAll('／', '/').replace(/[－–—]/g, '-');
  const match = /^(\d{1,3})\s*\/\s*(\d{1,4})(?:\s*-\s*(\d{1,4}))?$/.exec(text);
  if (!match) return null;
  const [, rackText, startText, endText] = match;
  const rack = Number(rackText), start = Number(startText), end = Number(endText || startText);
  if (!rack || !start || end < start || (endText && end === start)) return null;
  return { rack, start, end, location: `${rack}/${start}${end > start ? '-' + end : ''}` };
}

export function normalizeLocation(value) {
  return locationParts(value)?.location || '';
}

export function compareLocation(a, b) {
  const left = locationParts(a), right = locationParts(b);
  if (!left || !right) return a.localeCompare(b, undefined, { numeric: true });
  return left.rack - right.rack || left.start - right.start || left.end - right.end;
}

function cleanText(value) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

export function validateCatalog(items) {
  if (!Array.isArray(items) || !items.length || items.length > MAX_LAYOUT_ITEMS) {
    throw new LayoutError([`物料表需要 1–${MAX_LAYOUT_ITEMS} 条料盒记录。`]);
  }
  const issues = [], byLocation = new Map(), accepted = [];
  for (const [index, item] of items.entries()) {
    const row = Number.isSafeInteger(item?.row) && item.row > 0 ? item.row : index + 1;
    const prefix = `物料表第 ${row} 行`;
    const address = locationParts(item?.BX);
    const L = cleanText(item?.L), M = cleanText(item?.M), N = cleanText(item?.N);
    const rawQty = cleanText(item?.BI);
    const quantity = /^\d+$|^\d{1,3}(?:,\d{3})+$/.test(rawQty) ? Number(rawQty.replaceAll(',', '')) : NaN;
    if (!address) issues.push(`${prefix}的 BX 无效，请使用文本库位，例如 5/15 或 5/13-14。`);
    if (!L || L.length > 80 || /[\x00-\x1f]/.test(L)) issues.push(`${prefix}需要有效的客户物料号（L）。`);
    if (M.length > 512 || N.length > 128 || /\0/.test(M + N)) issues.push(`${prefix}的描述或规格超长，或包含无效字符。`);
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1_000_000_000) {
      issues.push(`${prefix}的补料数量（BI）必须为正整数。`);
    }
    if (!address) continue;
    const BX = address.location;
    if (byLocation.has(BX)) {
      issues.push(`${prefix}的 BX ${BX} 与第 ${byLocation.get(BX)} 行重复。`);
      continue;
    }
    byLocation.set(BX, row);
    accepted.push({ L, M, N, BI: String(quantity), BX, row });
  }
  const ordered = [...accepted].sort((a, b) => compareLocation(a.BX, b.BX));
  let prior = null;
  for (const item of ordered) {
    const address = locationParts(item.BX);
    if (prior && prior.rack === address.rack && prior.end >= address.start) {
      issues.push(`库位 ${prior.location} 与 ${address.location} 的编号区间重叠。`);
      if (prior.end >= address.end) continue;
    }
    prior = address;
  }
  if (issues.length) throw new LayoutError(issues);
  return accepted;
}

export function validateLayout(layout, catalog) {
  if (!Array.isArray(layout) || !layout.length || layout.length > MAX_LAYOUT_RACKS) {
    throw new LayoutError([`货架布局需要 1–${MAX_LAYOUT_RACKS} 组货架。`]);
  }
  const known = new Set(catalog.map(item => item.BX));
  const racks = new Set(), placed = new Set(), issues = [], accepted = [];
  for (const group of layout) {
    const rack = group?.rack;
    if (!Number.isInteger(rack) || rack < 1 || rack > 999 || racks.has(rack)) {
      issues.push(`货架号 ${rack ?? '（空）'} 无效或重复，请填写 1–999 的整数。`);
      continue;
    }
    racks.add(rack);
    if (!Array.isArray(group.cells) || !group.cells.length || group.cells.length > GRID_COLUMNS * MAX_SHELF_ROWS) {
      issues.push(`${rack} 号货架的料盒记录数量无效。`);
      continue;
    }
    const occupied = new Map(), cells = [];
    for (const cell of group.cells) {
      const address = locationParts(cell?.location);
      const label = `布局表${cell?.sourceRow ? '第 ' + cell.sourceRow + ' 行的' : '中的'}库位 ${address?.location || '（无效）'}`;
      if (!address || address.rack !== rack || !known.has(address.location)) {
        issues.push(`${label}无法匹配物料表中的 BX，或 BX 与货架号不一致。`);
        continue;
      }
      const location = address.location;
      if (placed.has(location)) { issues.push(`${label}被放置了多次。`); continue; }
      const { row, col, span, rowSpan } = cell;
      if (![row, col, span, rowSpan].every(n => Number.isInteger(n) && n >= 1) ||
          row + rowSpan - 1 > MAX_SHELF_ROWS || col + span - 1 > GRID_COLUMNS) {
        issues.push(`${label}的层、列或跨格无效，范围为 ${MAX_SHELF_ROWS} 层 × ${GRID_COLUMNS} 列。`);
        continue;
      }
      let conflict;
      for (let y = row; y < row + rowSpan; y++) {
        for (let x = col; x < col + span; x++) {
          const key = y * GRID_COLUMNS + x;
          if (occupied.has(key)) conflict ||= occupied.get(key);
          else occupied.set(key, location);
        }
      }
      if (conflict) issues.push(`${label}与 ${conflict} 在同一货架的网格重叠。`);
      placed.add(location);
      cells.push({ location, row, col, span, rowSpan });
    }
    accepted.push({ rack, cells: cells.sort((a, b) => a.row - b.row || a.col - b.col) });
  }
  if (issues.length) throw new LayoutError(issues);
  return accepted.sort((a, b) => a.rack - b.rack);
}

export function retainLayout(layout, catalog) {
  const known = new Set(catalog.map(item => item.BX));
  return layout.map(r => ({ rack: r.rack, cells: r.cells.filter(c => known.has(c.location)) })).filter(r => r.cells.length);
}

export function autoLayout(catalog, boxesPerShelf = 6) {
  if (!AUTO_ROW_OPTIONS.includes(boxesPerShelf)) throw new LayoutError(['请选择每层的料盒数。']);
  const racks = new Map();
  const width = GRID_COLUMNS / boxesPerShelf;
  for (const item of [...catalog].sort((a, b) => compareLocation(a.BX, b.BX))) {
    const { rack, start, end, location } = locationParts(item.BX);
    if (!racks.has(rack)) racks.set(rack, { rack, cells: [], row: 1, col: 1 });
    const group = racks.get(rack);
    const span = Math.min(boxesPerShelf, end - start + 1) * width;
    if (group.col + span - 1 > GRID_COLUMNS) { group.row++; group.col = 1; }
    group.cells.push({ location, row: group.row, col: group.col, span, rowSpan: 1 });
    group.col += span;
  }
  return [...racks.values()].map(({ rack, cells }) => ({ rack, cells }));
}

export function pendingConflicts(bins, current, incoming) {
  const old = new Map(current.map(item => [item.BX, item]));
  const next = new Map(incoming.map(item => [item.BX, item]));
  return bins.filter(bin => {
    if (bin.status !== 'pending') return false;
    const before = old.get(bin.location), after = next.get(bin.location);
    return !after || before?.L !== after.L || before?.BI !== after.BI;
  }).map(bin => bin.location).sort(compareLocation);
}
