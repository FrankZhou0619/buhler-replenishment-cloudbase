import { useEffect, useMemo, useState } from 'react';
import { Check, Download, FileSpreadsheet, ImagePlus, Info, LayoutGrid, Loader2, Upload, X } from 'lucide-react';
import {
  AUTO_ROW_OPTIONS, autoLayout, GRID_COLUMNS, LayoutError, MAX_LAYOUT_BYTES,
  MAX_LAYOUT_ITEMS, MAX_SHELF_ROWS, pendingConflicts, retainLayout, validateLayout
} from '../../shared/board-layout.mjs';
import { exportLayoutWorkbook, readLayoutWorkbook, type ImportedWorkbook } from '../lib/layout-workbook';
import type { Bin, BoardConfig, Item, Rack } from '../lib/model';
import { RackScene } from './rack-scene';

type LayoutMode = 'retain' | 'auto' | 'exact';
type Draft = ImportedWorkbook & { baseRevision: number; baseLayout: Rack[] };
export type LayoutPublish = { layoutRevision: number; source: string; catalog: Item[]; layout: Rack[] };
type Props = {
  board: BoardConfig;
  bins: Bin[];
  ready: boolean;
  onPublish: (config: LayoutPublish) => Promise<void>;
};
const errorMessage = (e: unknown) => e instanceof Error ? e.message : '无法处理此文件。';
const noBins: Bin[] = [];

export default function LayoutConfigurator({ board, bins = noBins, ready, onPublish }: Props) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [mode, setMode] = useState<LayoutMode>('retain');
  const [perShelf, setPerShelf] = useState(6);
  const [image, setImage] = useState<{ url: string; name: string } | null>(null);
  const [zoomImage, setZoomImage] = useState(false);
  const [rackNumber, setRackNumber] = useState(0);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<string[]>([]);
  const [imageError, setImageError] = useState('');
  const [confirm, setConfirm] = useState(false);

  useEffect(() => () => { if (image) URL.revokeObjectURL(image.url); }, [image]);

  const preview = useMemo(() => {
    if (!draft) return { layout: board.layout, issues: [] as string[] };
    try {
      const layout = mode === 'exact' ? draft.layout
        : mode === 'auto' ? autoLayout(draft.catalog, perShelf)
        : retainLayout(draft.baseLayout, draft.catalog);
      if (mode === 'retain' && !layout?.length) throw new LayoutError(['新物料表没有可沿用的图中库位。请选择按 BX 自动排布。']);
      return { layout: validateLayout(layout, draft.catalog), issues: [] as string[] };
    } catch (e) {
      return { layout: [] as Rack[], issues: e instanceof LayoutError ? e.issues : [errorMessage(e)] };
    }
  }, [board.layout, draft, mode, perShelf]);
  const catalog = draft?.catalog || board.catalog;
  const items = useMemo(() => new Map(catalog.map(item => [item.BX, item])), [catalog]);
  const current = useMemo(() => new Map(board.catalog.map(item => [item.BX, item])), [board.catalog]);
  const conflicts = draft ? pendingConflicts(bins, board.catalog, catalog) : [];
  const stale = Boolean(draft && draft.baseRevision !== board.layoutRevision);
  const mapped = preview.layout.reduce((count, r) => count + r.cells.length, 0);
  const rack = preview.layout.find(r => r.rack === rackNumber) || preview.layout[0];
  const selectedItem = rack?.cells.some(c => c.location === selected) ? items.get(selected) : undefined;
  const readyToPublish = Boolean(draft && ready && !busy && !stale && !conflicts.length && !preview.issues.length);
  const added = catalog.filter(item => !current.has(item.BX)).length;
  const removed = board.catalog.filter(item => !items.has(item.BX)).length;
  const changed = catalog.filter(item => {
    const old = current.get(item.BX);
    return old && (old.L !== item.L || old.BI !== item.BI || old.M !== item.M || old.N !== item.N);
  }).length;
  const reference = image?.url || board.referenceImage;

  async function importFile(getFile: () => File | Promise<File>) {
    if (busy) return;
    setDraft(null);
    setBusy('read');
    setError([]);
    setConfirm(false);
    setSelected('');
    try {
      const imported = await readLayoutWorkbook(await getFile());
      const preferred = imported.layout ? 'exact'
        : retainLayout(board.layout, imported.catalog).length ? 'retain' : 'auto';
      setMode(preferred);
      setDraft({ ...imported, baseRevision: board.layoutRevision, baseLayout: board.layout });
    } catch (e) { setError(e instanceof LayoutError ? e.issues : [errorMessage(e)]); }
    finally { setBusy(''); }
  }

  function loadExample() {
    void importFile(async () => {
      const workbook = await exportLayoutWorkbook(board.catalog, board.layout);
      return new File([workbook], 'Buhler_Layout_Example.xlsx', { type: workbook.type });
    });
  }

  function pickImage(file?: File) {
    if (!file) return;
    setImageError('');
    if (!/\.(png|jpe?g|webp)$/i.test(file.name) || !file.size || file.size > 10 * 1024 * 1024) {
      setImageError('请选择 10 MB 以内的 PNG、JPEG 或 WebP 图片。');
      return;
    }
    setImage({ url: URL.createObjectURL(file), name: file.name });
    setZoomImage(false);
  }

  async function downloadCurrent() {
    setBusy('export');
    setError([]);
    try {
      const blob = await exportLayoutWorkbook(board.catalog, board.layout);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `Buhler_layout_v${board.layoutRevision}.xlsx`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) { setError([errorMessage(e)]); }
    finally { setBusy(''); }
  }

  async function publish() {
    if (!readyToPublish || !draft) return;
    const payload = { layoutRevision: draft.baseRevision, source: draft.source.slice(0, 120), catalog, layout: preview.layout };
    if (new TextEncoder().encode(JSON.stringify({ ...payload, operationId: '0'.repeat(32) })).length > MAX_LAYOUT_BYTES) {
      setError(['布局数据超过单次发布上限。请缩短物料描述或减少本看板的库位。']);
      setConfirm(false);
      return;
    }
    setBusy('publish');
    setError([]);
    try { await onPublish(payload); setDraft(null); }
    catch (e) { setError([errorMessage(e)]); }
    finally { setBusy(''); setConfirm(false); }
  }

  const issues = [...error, ...preview.issues];
  return <div className="layout-config">
    <section className="surface layout-controls">
      <div className="section-top">
        <div><h2><FileSpreadsheet size={18} />导入配置</h2><p>当前布局 v{board.layoutRevision} · {board.catalog.length} 个库位</p></div>
        <div className="layout-config-tools">
          <button type="button" className="secondary-button" onClick={loadExample} disabled={!!busy}>载入示例</button>
          <button type="button" className="secondary-button" onClick={downloadCurrent} disabled={!!busy}><Download size={16} />下载当前配置 Excel</button>
        </div>
      </div>
      <div className="layout-control-body">
        <div className="layout-upload-grid">
          <label className="layout-upload">
            <b><Upload size={16} />物料与布局 Excel</b>
            <span>支持原始 Master 表或下载的配置表 · 每份最多 {MAX_LAYOUT_ITEMS} 个库位</span>
            <input type="file" aria-label="导入物料与布局 Excel" accept=".xlsx" disabled={!!busy}
              onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void importFile(() => file); }} />
            {draft && <small>{draft.source}</small>}
            {busy === 'read' && <small><Loader2 size={14} className="spin" />正在读取 Excel</small>}
          </label>
          <label className="layout-upload">
            <b><ImagePlus size={16} />现场布局图（选填）</b>
            <span>在预览中对照图纸，图片仅保留在本次页面</span>
            <input type="file" aria-label="选择现场布局参考图" accept=".png,.jpg,.jpeg,.webp" disabled={!!busy}
              onChange={e => { pickImage(e.target.files?.[0]); e.target.value = ''; }} />
            {image && <small>{image.name}</small>}
            {imageError && <small role="alert" className="layout-error-text">{imageError}</small>}
          </label>
        </div>
        {draft && <div className="layout-options">
          <label>排布方式<select aria-label="排布方式" value={mode} disabled={!!busy}
            onChange={e => { setMode(e.target.value as LayoutMode); setConfirm(false); setError([]); setSelected(''); }}>
            <option value="retain">沿用当前布局</option>
            <option value="auto">按 BX 自动排布</option>
            <option value="exact" disabled={!draft.layout}>按货架布局表精确排布</option>
          </select></label>
          {mode === 'auto' && <label>每层标准盒位数<select aria-label="每层标准盒位数" value={perShelf} disabled={!!busy}
            onChange={e => { setPerShelf(Number(e.target.value)); setConfirm(false); setSelected(''); }}>
            {AUTO_ROW_OPTIONS.map(n => <option key={n}>{n}</option>)}
          </select></label>}
          <p>{mode === 'exact'
            ? `在「货架布局」中填写层、列、跨列、跨层。每架最多 ${MAX_SHELF_ROWS} 层，宽度分为 ${GRID_COLUMNS} 格。`
            : mode === 'auto' ? '按 BX 的货架编号分组，按料盒编号顺序从左到右排布，合并编号对应一个宽料盒。'
            : '保留同一 BX 在当前货架图的位置。新增且未排布的库位放入图外列表。'}</p>
        </div>}
        {issues.length > 0 && <div role="alert" className="layout-issues">
          <b>请检查配置</b>
          <ul>{issues.slice(0, 8).map((issue, i) => <li key={i}>{issue}</li>)}</ul>
          {issues.length > 8 && <small>共 {issues.length} 项，修正后重新导入。</small>}
        </div>}
      </div>
    </section>

    <div className={`layout-preview-grid ${reference ? 'has-reference' : ''}`}>
      <section className="surface layout-preview">
        <div className="section-top">
          <div><h2><LayoutGrid size={18} />{draft ? '导入预览' : '当前布局'}</h2><p>{preview.layout.length} 组货架 · 图中 {mapped} 个 · 图外 {catalog.length - mapped} 个</p></div>
          {rack && <select aria-label="预览货架" value={rack.rack} onChange={e => { setRackNumber(Number(e.target.value)); setSelected(''); }}>
            {preview.layout.map(r => <option key={r.rack} value={r.rack}>{String(r.rack).padStart(2, '0')} 号货架</option>)}
          </select>}
        </div>
        <div className="layout-rack-preview">
          {rack && <RackScene racks={[rack]} items={items} focused={selected} preview onItem={item => setSelected(item.BX)} />}
          {selectedItem && <div className="layout-item-preview">
            <b>{selectedItem.BX}</b><span>{selectedItem.L}</span>
            <span>{[selectedItem.M, selectedItem.N].filter(Boolean).join(' · ')}</span><span>补料数量 {selectedItem.BI}</span>
          </div>}
          {!rack && <p className="empty-small">修正配置后即可预览</p>}
        </div>
      </section>
      {reference && <section className="surface layout-reference">
        <div className="section-top">
          <div><h2>现场参考图</h2><p>{image?.name || '原始 Bühler Wuxi 货架布局'}</p></div>
          <div className="layout-reference-actions">
            <button type="button" className="secondary-button small" aria-expanded={zoomImage} onClick={() => setZoomImage(!zoomImage)}>
              {zoomImage ? '适应宽度' : '放大'}
            </button>
            {image && <button type="button" className="icon-button" aria-label="移除参考图" onClick={() => { setImage(null); setZoomImage(false); }}><X size={17} /></button>}
          </div>
        </div>
        <div className={`layout-reference-img ${zoomImage ? 'zoomed' : ''}`}>
          <img src={reference} alt="现场货架布局参考图" onError={() => {
            if (image) { setImage(null); setImageError('图片无法读取，请检查文件格式。'); }
          }} />
        </div>
      </section>}
    </div>

    {draft && <section className="surface layout-publish">
      <div className="section-top">
        <div><h2>发布货架布局</h2><p>新增 {added} 个 · 移除 {removed} 个 · 物料信息更新 {changed} 个</p></div>
        {!confirm && <button type="button" className="primary-button" disabled={!readyToPublish} onClick={() => setConfirm(true)}><Check size={16} />发布到看板</button>}
      </div>
      <div className="layout-publish-body">
        {stale && <div role="alert" className="layout-issues">当前布局已被其他终端更新，请重新导入并核对预览。</div>}
        {conflicts.length > 0 && <div role="alert" className="layout-issues">
          库位 {conflicts.slice(0, 10).join('、')}{conflicts.length > 10 ? ` 等 ${conflicts.length} 个` : ''}还有待补料记录。请先完成补料或撤销报缺，再改这些库位的物料或数量。
        </div>}
        {confirm && <div className="layout-confirm">
          <p>发布后，登录终端将同步这份布局。请确认现场标签与预览中的 BX 一致。</p>
          <button type="button" className="secondary-button" disabled={!!busy} onClick={() => setConfirm(false)}>返回预览</button>
          <button type="button" className="primary-button" disabled={!readyToPublish} onClick={publish}>
            {busy === 'publish' && <Loader2 size={15} className="spin" />}确认发布
          </button>
        </div>}
        {!confirm && <p className="layout-note"><Info size={16} />发布会保留已有补料单。同库位、同物料的状态会继续使用。</p>}
      </div>
    </section>}
  </div>;
}
