import { Loader2 } from 'lucide-react';
import { GRID_COLUMNS } from '../../shared/board-layout.mjs';
import type { Bin, Item, Rack } from '../lib/model';

type RackSceneProps = {
  racks: Rack[];
  items: Map<string, Item>;
  bins?: Map<string, Bin>;
  ready?: boolean;
  match?: (item: Item) => boolean;
  focused?: string;
  busy?: string;
  zoom?: number;
  preview?: boolean;
  pendingIndicator?: (item: Item) => { label: string; symbol: string; tone: string };
  onItem: (item: Item) => void;
};

export function RackScene({ racks, items, bins, ready = true, match, focused, busy, zoom = 1, preview, pendingIndicator, onItem }: RackSceneProps) {
  if (!racks.length) return <div className="empty-small">当前没有可展示的货架</div>;
  const single = racks.length === 1;
  return <div className="rack-scroll">
    <div className={`rack-scene ${single ? 'single-rack' : ''}`} style={{
      gridTemplateColumns: `repeat(${racks.length}, minmax(${single ? 0 : 245}px, 1fr))`,
      minWidth: single ? (zoom > 1 ? `${zoom * 100}%` : undefined) : racks.length * 261 * zoom
    }}>
      {racks.map(rack => {
        const rows = Math.max(...rack.cells.map(cell => cell.row + cell.rowSpan - 1));
        const pending = rack.cells.filter(cell => bins?.get(cell.location)?.status === 'pending').length;
        return <div className="rack" key={rack.rack}>
          <div className="rack-title">
            <div><span>{String(rack.rack).padStart(2, '0')}</span><b>号货架</b></div>
            <span className={pending ? 'rack-badge has-pending' : 'rack-badge'}>{pending ? `${pending} 待补` : `${rack.cells.length} 料盒`}</span>
          </div>
          <div className="rack-body">
            <div className="rack-upright left" /><div className="rack-upright right" />
            <div className="shelf-grid" style={{ gridTemplateRows: `repeat(${rows}, var(--rack-row-height, 50px))` }}>
              {Array.from({ length: rows }, (_, i) => <div key={i} className="shelf-beam" style={{ gridRow: i + 1, gridColumn: `1 / ${GRID_COLUMNS + 1}` }} />)}
              {rack.cells.map(cell => {
                const item = items.get(cell.location);
                if (!item) return null;
                const status = bins?.get(cell.location)?.status || 'full';
                const visible = match?.(item) ?? true;
                const indicator = status === 'pending' ? pendingIndicator?.(item) : undefined;
                const label = preview ? `预览料盒 ${cell.location}` : `${cell.location} ${item.L} ${status === 'pending' ? '待补料' : '满料'}${indicator ? ' · ' + indicator.label : ''}`;
                return <button type="button" key={cell.location}
                  className={`bin ${status} ${visible ? '' : 'muted-bin'} ${focused === cell.location ? 'focused-bin' : ''}`}
                  disabled={!ready || !visible} onClick={() => onItem(item)} aria-label={label} data-stock-tone={indicator?.tone}
                  title={`${cell.location} · ${item.L}\n${item.M}\n${item.N}\n补料数量：${item.BI}`}
                  style={{ gridColumn: `${cell.col} / span ${cell.span}`, gridRow: `${cell.row} / span ${cell.rowSpan}` }}>
                  <span className="bin-lip" /><span className="bin-code">{cell.location}</span>
                  <span className="bin-status">{status === 'pending' ? <><span className="pending-mark">{indicator?.symbol ?? '!'}</span>{cell.span >= 4 ? '待补' : ''}</> : <span className="bin-line" />}</span>
                  {busy === cell.location && <Loader2 size={12} className="spin bin-loading" />}
                </button>;
              })}
            </div>
            <div className="rack-base"><span /><span /><span /></div>
          </div>
          <div className="rack-footer">{preview
            ? <><span>{rack.cells.length} 个料盒</span><span>{rows} 层</span></>
            : <><span className={pending ? 'amber-text' : ''}>{rack.cells.length - pending} 满料</span><span>{pending} 待补料</span></>}
          </div>
        </div>;
      })}
    </div>
  </div>;
}
