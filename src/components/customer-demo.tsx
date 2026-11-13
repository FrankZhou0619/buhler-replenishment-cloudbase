import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { ChartNoAxesCombined, Download, FlaskConical, RotateCcw, ShieldCheck, Upload, Warehouse } from 'lucide-react';
import { RackScene } from '@/components/rack-scene';
import {
  aggregateBom, bomHeaders, canChangeBin, changeDemoBin, demoRoles, makeDemoSamples, materialKey,
  parseBomRows, parseUsageRows, standardQuantity, stockStatus, stockStatuses, usageDeviation, usageHeaders,
  type BinAction, type BomRow, type DemoInventory, type DemoRole, type UsageRow
} from '@/lib/customer-demo';
import { fullBin, type Bin, type Item, type Rack } from '@/lib/model';
import { exportWorkbook, readFirstWorksheet } from '@/lib/layout-workbook';

const tabs = [
  { id: 'roles', label: '权限演示', icon: ShieldCheck },
  { id: 'vmi', label: '补料与 VMI', icon: Warehouse },
  { id: 'usage', label: '用量预警', icon: ChartNoAxesCombined },
  { id: 'bom', label: '样机备料', icon: FlaskConical }
] as const;
type DemoView = typeof tabs[number]['id'];
const roleEntries = Object.entries(demoRoles) as [DemoRole, typeof demoRoles[DemoRole]][];
const numberFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });
const format = (value: number | null | undefined) => value == null ? '—' : numberFormat.format(value);
const rackLabel = (rack: number) => `${String(rack).padStart(2, '0')} 号货架`;
const binLabels: Record<BinAction, string> = { request: '标记待补料', cancel: '撤销需求', dispatch: '下发补料需求', refill: '确认补入' };
const binActions: BinAction[] = ['request', 'cancel', 'dispatch', 'refill'];

function WorkbookControls({ label, headers, example, canImport, onImport }: {
  label: string;
  headers: string[];
  example: (string | number)[][];
  canImport: () => boolean;
  onImport: (rows: string[][], name: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const active = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  async function download() {
    try {
      const blob = await exportWorkbook([{ name: label, rows: [headers, ...example], widths: headers.map(() => 21), textColumns: [0, 1] }]);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `布勒-${label}-演示模板.xlsx`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 3000);
    } catch {
      setError(true);
      setMessage('模板生成失败，请重试。');
    }
  }

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || busy || !canImport()) return;
    setBusy(true);
    setMessage('');
    setError(false);
    try {
      const columns = headers.map((_, index) => String.fromCharCode(65 + index));
      const rows = await readFirstWorksheet(file, columns);
      if (!active.current) return;
      if (!canImport()) throw new Error('当前角色无导入权限，请切回项目管理员重试。');
      onImport(rows, file.name);
      setMessage(`已载入 ${file.name}，试算结果已更新。`);
    } catch (e) {
      if (!active.current) return;
      setError(true);
      setMessage(e instanceof Error ? e.message : '无法读取文件，请使用本页模板。');
    } finally {
      if (active.current) setBusy(false);
    }
  }

  return (
    <>
      <div className="concept-tools">
        <button type="button" className="secondary-button small" onClick={download}><Download size={15} />下载 Excel 模板</button>
        <button type="button" className="secondary-button small" disabled={busy || !canImport()} onClick={() => input.current?.click()}>
          <Upload size={15} />{busy ? '正在读取…' : '导入 Excel'}
        </button>
        <input ref={input} type="file" accept=".xlsx" hidden onChange={upload} aria-label={`导入${label} Excel`} />
        {!canImport() && <small>切换到项目管理员可导入。</small>}
      </div>
      {message && <p className={`concept-message${error ? ' error' : ''}`} role={error ? 'alert' : 'status'}>{message}</p>}
    </>
  );
}

function RolePreview({ role }: { role: DemoRole }) {
  return (
    <section className="surface">
      <div className="section-top"><h2>四个角色的操作范围</h2><small>切换上方角色，再到对应页面试操作。</small></div>
      <div className="table-scroll">
        <table className="concept-role-table">
          <thead><tr><th>角色</th><th>报缺</th><th>撤销未下发需求</th><th>下发补料需求</th><th>确认补入</th><th>导入与设置阈值</th></tr></thead>
          <tbody>
            {roleEntries.map(([id, info]) => (
              <tr key={id} className={id === role ? 'concept-current-role' : ''}>
                <td><b>{info.label}</b>{id === role && <small className="concept-current-tag">当前角色</small>}</td>
                <td>{info.request ? '可操作' : '—'}</td>
                <td>{info.dispatch ? '演示货架' : info.request ? '本人需求' : '—'}</td>
                <td>{info.dispatch ? '可操作' : '—'}</td>
                <td>{info.refill ? '已下发需求' : '—'}</td>
                <td>{info.plan ? '可操作' : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="concept-footnote">演示中由项目管理员代入采购和计划人员的数据录入操作。</p>
    </section>
  );
}

function VmiPreview({ racks, items, inventory, role, onChange }: {
  racks: Rack[];
  items: Map<string, Item>;
  inventory: DemoInventory;
  role: DemoRole;
  onChange: (action: BinAction, item: Item) => void;
}) {
  const [rackId, setRackId] = useState(racks[0]?.rack);
  const rack = racks.find(row => row.rack === rackId);
  const [location, setLocation] = useState(racks[0]?.cells[0]?.location);
  const [notice, setNotice] = useState('');
  const item = items.get(location);
  const request = inventory.requests.get(location);
  const available = item ? inventory.stock.get(materialKey(item.L)) : undefined;
  const status = item ? stockStatus(available, request?.quantity ?? standardQuantity(item)) : stockStatuses.unknown;
  const allowed = binActions.filter(action => canChangeBin(role, action, request, available));
  const bins = new Map<string, Bin>([...inventory.requests.keys()].map(location => [location, { ...fullBin(location), status: 'pending' }]));
  const pending = rack?.cells.flatMap(cell => {
    const demand = inventory.requests.get(cell.location);
    const material = items.get(cell.location);
    return demand && material ? [{ material, demand }] : [];
  }) ?? [];

  function chooseItem(item: Item) {
    setLocation(item.BX);
    setNotice('');
  }

  function submit(action: BinAction, item: Item) {
    onChange(action, item);
    if (action === 'refill' && request && available !== undefined) {
      const supplied = Math.min(request.quantity, available);
      setNotice(`已模拟补入 ${format(supplied)} 件${supplied < request.quantity ? `，剩余 ${format(request.quantity - supplied)} 件待补` : ''}。`);
    } else setNotice(`已${binLabels[action]}。`);
  }

  return (
    <div className="concept-vmi">
      <section className="surface concept-rack-panel">
        <div className="section-top">
          <h2>货架补料看板</h2>
          <select aria-label="选择演示货架" value={rackId} onChange={event => {
            const next = racks.find(row => row.rack === Number(event.target.value));
            if (next) {
              setRackId(next.rack);
              setLocation(next.cells[0]?.location);
              setNotice('');
            }
          }}>
            {racks.map(row => <option key={row.rack} value={row.rack}>{rackLabel(row.rack)}</option>)}
          </select>
        </div>
        <RackScene racks={rack ? [rack] : []} items={items} bins={bins} focused={location} onItem={chooseItem}
          pendingIndicator={item => stockStatus(inventory.stock.get(materialKey(item.L)), inventory.requests.get(item.BX)?.quantity ?? standardQuantity(item))} />
        <div className="concept-legend" aria-label="待补料盒库存状态">
          {Object.values(stockStatuses).map(state => <span key={state.tone} className={`concept-stock ${state.tone}`}><b aria-hidden>{state.symbol}</b>{state.label}</span>)}
        </div>
      </section>
      <div className="concept-vmi-side">
        <section className="surface">
          <div className="section-top"><h2>{item ? `库位 ${item.BX}` : '选择库位'}</h2>{item && <span className={`concept-stock ${status.tone}`}>{status.label}</span>}</div>
          {item && <>
            <div className="concept-bin-info">
              <div className="concept-item"><b>{item.L}</b><span>{item.M} · {item.N}</span></div>
              <dl>
                <div><dt>{request ? '待补需求' : '标准补料量'}</dt><dd>{format(request?.quantity ?? standardQuantity(item))} 件</dd></div>
                <div><dt>样例 VMI 可用量</dt><dd>{available === undefined ? '未获取' : `${format(available)} 件`}</dd></div>
                <div><dt>料盒状态</dt><dd>{!request ? '满料' : request.dispatched ? '待补 · 已下发' : '待补 · 未下发'}</dd></div>
              </dl>
              {allowed.length > 0 && <div className="concept-tools">
                {allowed.map(action => <button type="button" className={action === 'cancel' ? 'secondary-button small' : 'primary-button small'} key={action} onClick={() => submit(action, item)}>
                  {action === 'refill' && request && available !== undefined ? `确认补入 ${format(Math.min(request.quantity, available))} 件` : binLabels[action]}
                </button>)}
              </div>}
              {!allowed.length && <small className="concept-hint">当前状态或角色下暂无可执行操作。</small>}
              {notice && <p className="concept-message" role="status">{notice}</p>}
            </div>
          </>}
        </section>
        <section className="surface">
          <div className="section-top"><h2>本架待补</h2><small>{pending.length} 个料盒</small></div>
          <div className="concept-pending">
            {!pending.length && <p className="concept-footnote">当前货架暂无待补料盒。</p>}
            {pending.map(({ material, demand }) => {
              const state = stockStatus(inventory.stock.get(materialKey(material.L)), demand.quantity);
              return (
                <button type="button" key={material.BX} aria-pressed={location === material.BX} onClick={() => chooseItem(material)}>
                  <span><b>{material.BX}</b><small>{material.L} · {demand.dispatched ? '已下发' : '未下发'}</small></span>
                  <span className={`concept-stock ${state.tone}`}>{state.label}</span>
                </button>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}

function UsagePreview({ rows, sample, source, canImport, onImport }: {
  rows: UsageRow[];
  sample: UsageRow[];
  source: string;
  canImport: () => boolean;
  onImport: (rows: UsageRow[], name: string) => void;
}) {
  const [requestedPeriod, setRequestedPeriod] = useState(rows[0]?.period);
  const [thresholdInput, setThresholdInput] = useState('20');
  const periods = [...new Set(rows.map(row => row.period))].sort().reverse();
  const period = periods.includes(requestedPeriod) ? requestedPeriod : periods[0];
  const threshold = Math.min(1000, Math.max(0, Number(thresholdInput) || 0));
  const active = rows.filter(row => row.period === period).map(row => ({ ...row, result: usageDeviation(row, threshold) }));
  const alarms = active.filter(row => row.result.alert).length;

  return (
    <section className="surface">
      <div className="section-top"><h2>预测与实际用量</h2><small>{source}</small></div>
      <div className="concept-panel-body">
        <div className="concept-form-row">
          <label>期间<select value={period} onChange={event => setRequestedPeriod(event.target.value)}>
            {periods.map(value => <option key={value}>{value}</option>)}
          </select></label>
          <label>偏差阈值（%）<input type="number" min={0} max={1000} step={1} value={thresholdInput} disabled={!canImport()}
            onChange={event => setThresholdInput(event.target.value)} onBlur={() => setThresholdInput(String(threshold))} /></label>
          <div className="concept-metric"><b>{alarms}</b><span>项预警</span></div>
        </div>
        <p className="concept-hint">按件比较同一期间。高于或低于预测超过阈值时提示，实际用量留空会显示暂无实绩。</p>
        <WorkbookControls label="用量对比" headers={usageHeaders} canImport={canImport}
          example={sample.map(row => [row.period, row.material, row.forecast, row.actual ?? ''])}
          onImport={(values, name) => onImport(parseUsageRows(values), name)} />
      </div>
      <div className="table-scroll concept-table">
        <table>
          <thead><tr><th>客户物料号</th><th className="number">预测量</th><th className="number">实际用量</th><th className="number">数量差</th><th className="number">偏差</th><th>结果</th></tr></thead>
          <tbody>{active.map(row => <tr key={materialKey(row.material)}>
            <td className="mono">{row.material}</td><td className="number">{format(row.forecast)}</td>
            <td className="number">{format(row.actual)}</td><td className="number">{format(row.result.difference)}</td>
            <td className="number">{row.result.rate === null ? '—' : `${format(row.result.rate)}%`}</td>
            <td><span className={`concept-stock ${row.result.alert ? 'empty' : row.actual === null ? 'unknown' : 'okay'}`}>{row.result.status}</span></td>
          </tr>)}</tbody>
        </table>
      </div>
    </section>
  );
}

function BomPreview({ rows, sample, source, stock, materials, canImport, onImport }: {
  rows: BomRow[];
  sample: BomRow[];
  source: string;
  stock: Map<string, number>;
  materials: Map<string, Item>;
  canImport: () => boolean;
  onImport: (rows: BomRow[], name: string) => void;
}) {
  const [requestedModel, setRequestedModel] = useState(rows[0]?.model);
  const [unitsInput, setUnitsInput] = useState('5');
  const models = [...new Set(rows.map(row => row.model))];
  const model = models.includes(requestedModel) ? requestedModel : models[0];
  const units = Math.min(9999, Math.max(1, Math.floor(Number(unitsInput) || 1)));
  const items = aggregateBom(rows, model, units).map(row => {
    const key = materialKey(row.material);
    const material = materials.get(key);
    const available = stock.get(key);
    const gap = available === undefined ? undefined : Math.max(row.needed - available, 0);
    const state = !material ? { label: '未匹配物料', tone: 'unknown' } :
      gap === undefined ? { label: '库存未获取', tone: 'unknown' } :
        gap > 0 ? { label: '有缺口', tone: 'empty' } : { label: '库存足够', tone: 'okay' };
    return { ...row, materialName: material?.M, available, gap, state };
  });

  return (
    <section className="surface">
      <div className="section-top"><h2>样机需求与库存匹配</h2><small>{source}</small></div>
      <div className="concept-panel-body">
        <div className="concept-form-row">
          <label>样机型号<select value={model} onChange={event => setRequestedModel(event.target.value)}>
            {models.map(value => <option key={value}>{value}</option>)}
          </select></label>
          <label>计划台数<input type="number" min={1} max={9999} step={1} value={unitsInput}
            onChange={event => setUnitsInput(event.target.value)} onBlur={() => setUnitsInput(String(units))} /></label>
          <div className="concept-metric"><b>{items.filter(item => (item.gap ?? 0) > 0).length}</b><span>项有缺口</span></div>
        </div>
        <p className="concept-hint">同型号的重复物料合并后乘以计划台数，再按件与样例 VMI 可用量比较。</p>
        <WorkbookControls label="样机需求" headers={bomHeaders} canImport={canImport}
          example={sample.map(row => [row.model, row.material, row.perUnit])}
          onImport={(values, name) => onImport(parseBomRows(values), name)} />
      </div>
      <div className="table-scroll concept-table">
        <table>
          <thead><tr><th>客户物料号</th><th>物料描述</th><th className="number">需求量</th><th className="number">可用量</th><th className="number">缺口</th><th>结果</th></tr></thead>
          <tbody>{items.map(item => <tr key={materialKey(item.material)}>
            <td className="mono">{item.material}</td><td className="concept-description">{item.materialName ?? '—'}</td>
            <td className="number">{format(item.needed)}</td><td className="number">{format(item.available)}</td><td className="number">{format(item.gap)}</td>
            <td><span className={`concept-stock ${item.state.tone}`}>{item.state.label}</span></td>
          </tr>)}</tbody>
        </table>
      </div>
    </section>
  );
}

export default function CustomerDemo({ catalog, layout, initialRole = 'admin' }: { catalog: Item[]; layout: Rack[]; initialRole?: DemoRole }) {
  const racks = useMemo(() => layout.slice(0, 2), [layout]);
  const sample = useMemo(() => makeDemoSamples(catalog, racks), [catalog, racks]);
  const items = useMemo(() => new Map(catalog.map(item => [item.BX, item])), [catalog]);
  const materials = useMemo(() => new Map(catalog.map(item => [materialKey(item.L), item])), [catalog]);
  const [view, setView] = useState<DemoView>('vmi');
  const [role, setRole] = useState<DemoRole>(initialRole);
  const roleRef = useRef(role);
  const [inventory, setInventory] = useState(sample.inventory);
  const [usage, setUsage] = useState({ rows: sample.usage, source: '示例用量' });
  const [bom, setBom] = useState({ rows: sample.bom, source: '示例样机 BOM' });
  const [resetCount, setResetCount] = useState(0);
  const canImport = () => demoRoles[roleRef.current].plan;

  function selectRole(value: DemoRole) {
    roleRef.current = value;
    setRole(value);
  }

  function reset() {
    setInventory(sample.inventory);
    setUsage({ rows: sample.usage, source: '示例用量' });
    setBom({ rows: sample.bom, source: '示例样机 BOM' });
    setResetCount(count => count + 1);
  }

  return (
    <div className="customer-demo">
      <section className="surface concept-context">
        <div className="concept-context-main">
          <div><b>样例数据</b><p>角色切换、库存和上传文件仅用于本页演示，离开演示或刷新后恢复示例。</p></div>
          <button type="button" className="secondary-button small" onClick={reset}><RotateCcw size={15} />恢复示例</button>
        </div>
        <div className="concept-role-picker">
          <label>模拟登录角色<select value={role} onChange={event => selectRole(event.target.value as DemoRole)}>
            {roleEntries.map(([key, info]) => <option key={key} value={key}>{info.label}</option>)}
          </select></label>
          <span>{demoRoles[role].description}</span>
        </div>
      </section>
      <nav className="concept-tabs" aria-label="客户演示功能">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button type="button" key={id} aria-pressed={id === view} onClick={() => setView(id)}><Icon size={17} />{label}</button>
        ))}
      </nav>
      {view === 'roles' && <RolePreview role={role} />}
      <div hidden={view !== 'vmi'}><VmiPreview key={resetCount} racks={racks} items={items} inventory={inventory} role={role}
        onChange={(action, item) => setInventory(current => changeDemoBin(current, role, action, item))} /></div>
      <div hidden={view !== 'usage'}><UsagePreview key={resetCount} {...usage} sample={sample.usage} canImport={canImport}
        onImport={(rows, source) => setUsage({ rows, source })} /></div>
      <div hidden={view !== 'bom'}><BomPreview key={resetCount} {...bom} sample={sample.bom} stock={inventory.stock} materials={materials} canImport={canImport}
        onImport={(rows, source) => setBom({ rows, source })} /></div>
    </div>
  );
}
