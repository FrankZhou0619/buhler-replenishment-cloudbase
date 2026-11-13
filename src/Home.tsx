'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowRight, Box, Check, CheckCheck, CheckCircle2, ChevronDown, ChevronRight, CircleHelp, ClipboardList, Clock3, Code2, Download, ExternalLink, FileCheck2, FileSpreadsheet, History, Info, LayoutGrid, List, Loader2, Mail, PackageCheck, Plus, RefreshCw, ScanFace, Search, Send, Settings, ShieldCheck, SlidersHorizontal, Undo2, Warehouse, WifiOff, X, ZoomIn, ZoomOut } from 'lucide-react';
import ArimsDebugger from './components/arims-debugger';
import { AccessSettings, FaceProfile } from './components/access-settings';
import CustomerDemo from './components/customer-demo';
import FiveSBoard from './components/five-s-board';
import { permits } from '../shared/access.mjs';
import LayoutConfigurator, { type LayoutPublish } from './components/layout-configurator';
import { RackScene } from './components/rack-scene';
import type { Actor } from './lib/bootstrap';
import { apiFetch } from '@cloud-client';
import { csv, fullBin, headings, mailText, type Bin, type BoardConfig, type Item, type Order, type Snapshot } from '@/lib/model';
import { compareLocation } from '../shared/board-layout.mjs';

type View = 'board' | 'orders' | 'history' | 'settings' | 'help' | 'arims' | 'layout' | 'access' | 'face-profile' | 'five-s' | 'customer-demo';
type RefillTarget = { item: Item; revision: number; requestId: string | null };
type Modal = { type: 'item'; item: Item } | { type: 'review' } | { type: 'order'; order: Order } |
  { type: 'confirmBatch'; scope: 'all' | 'selected'; items: RefillTarget[]; layoutRevision: number } | null;
type Toast = { text: string; error?: boolean; undo?: () => void };
const fmt = (s: string) => new Date(s).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const shortId = (id: string) => id.length > 24 ? id.slice(0, 23) : id;
const rackLabel = (rack: number) => String(rack).padStart(2, '0');
async function readResponse<T>(response: Response) { return await response.json() as T & { error?: string }; }
function operationId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
}
function saveFile(name: string, data: string, type = 'text/plain;charset=utf-8') {
  const u = URL.createObjectURL(new Blob([data], { type })), a = document.createElement('a');
  a.href = u; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(u), 3000);
}
function encoded(s: string) {
  const bytes = new TextEncoder().encode(s); let binary = '';
  bytes.forEach(b => binary += String.fromCharCode(b)); return btoa(binary);
}
function draft(order: Order, recipient: string) {
  const boundary = 'buhler_' + order.id;
  const wrap = (s: string) => s.match(/.{1,76}/g)?.join('\r\n') || '';
  const text = ['MIME-Version: 1.0', 'X-Unsent: 1', `To: ${recipient.replace(/[\r\n]/g, '')}`, `Subject: =?UTF-8?B?${encoded(`【Bühler 补料】${order.items.length} 个料盒 · ${order.id}`)}?=`, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', wrap(encoded(mailText(order))), `--${boundary}`, 'Content-Type: text/csv; charset=utf-8', `Content-Disposition: attachment; filename="${order.id}.csv"`, 'Content-Transfer-Encoding: base64', '', wrap(encoded(csv(order.items))), `--${boundary}--`, ''].join('\r\n');
  saveFile(`${order.id}.eml`, text, 'message/rfc822');
}
function MaterialTable({ items, bins, onItem, onAction, mode, disabled }: { items: Item[]; bins: Map<string, Bin>; onItem: (item: Item) => void; onAction?: (item: Item) => void; mode?: string; disabled?: boolean }) {
  return <div className="table-scroll"><table><thead><tr><th>料盒位置 <small>BX</small></th><th>客户物料号 <small>L</small></th><th>物料描述 <small>M</small></th><th>规格 <small>N</small></th><th className="number">补料数量 <small>BI</small></th><th>料盒状态</th>{onAction && <th>操作</th>}</tr></thead><tbody>{items.map(item => { const b = bins.get(item.BX) || fullBin(item.BX); return <tr key={item.BX}><td><button className="location-link" onClick={() => onItem(item)}>{item.BX}</button></td><td className="mono">{item.L}</td><td className="description-cell">{item.M}</td><td>{item.N}</td><td className="number mono">{Number(item.BI).toLocaleString()}</td><td><span className={`pill ${b.status === 'pending' ? 'amber' : 'green'}`}><i />{b.status === 'pending' ? '待补料' : '满料'}</span></td>{onAction && <td><button className="text-button" disabled={disabled || (mode === 'refill' && b.status === 'full')} onClick={() => onAction(item)}>{mode === 'refill' ? '确认补满' : b.status === 'full' ? '标记缺料' : '查看'}</button></td>}</tr>; })}</tbody></table>{!items.length && <div className="empty-small">没有符合条件的物料</div>}</div>;
}

function MailDeliveryResults({ order }: { order: Order }) {
  if (!order.deliveries?.length) return null;
  const labels: Record<string, string> = { prepared: '待提交', sending: '提交中 · 待核实', sent: '已提交', failed: '提交失败', uncertain: '结果待核实' };
  return <section className="delivery-results" aria-label="逐人发送结果"><div className="delivery-heading"><b>逐人发送结果</b><small>已提交表示MailerSend接收，实际送达请在邮箱确认</small></div>{order.deliveries.map(d => <div className="delivery-row" key={d.recipient}><div><span>{d.recipient}</span><span className={`pill ${d.status === 'sent' ? 'green' : 'amber'}`}>{labels[d.status] || d.status}</span></div>{d.error && <p>{d.error}</p>}</div>)}</section>;
}

export default function Home({ actor, initialBoard, onLogout }: { actor: Actor; initialBoard: BoardConfig; onLogout: () => void }) {
  const canInspect = permits(actor.role, 'report'), canRefill = permits(actor.role, 'refill');
  const canDispatch = permits(actor.role, 'dispatch'), isAdmin = permits(actor.role, 'manage');
  const canCancel = (bin: Bin) => canInspect && !bin.request_id && (permits(actor.role, 'cancelOthers') || bin.reported_by_uid === actor.uid);
  const [view, setView] = useState<View>('board'), [mode, setMode] = useState<'inspect' | 'refill'>(actor.role === 'refill' ? 'refill' : 'inspect');
  const [refillSelection, setRefillSelection] = useState<Map<string, number>>(() => new Map());
  const [{ board, snapshot }, setFrame] = useState<{ board: BoardConfig; snapshot: Snapshot | null }>({ board: initialBoard, snapshot: null });
  const { catalog, layout, referenceImage, layoutRevision } = board;
  const boardRef = useRef(initialBoard), refreshSequence = useRef(0), lastRefresh = useRef(0);
  const [loadError, setLoadError] = useState(''), [busy, setBusy] = useState('');
  const [modal, setModal] = useState<Modal>(null), [toast, setToast] = useState<Toast | null>(null);
  const [group, setGroup] = useState('group-0'), [display, setDisplay] = useState<'rack' | 'list'>('rack');
  const [search, setSearch] = useState(''), [filter, setFilter] = useState('all'), [zoom, setZoom] = useState(1);
  const [operatorName] = useState(actor.label), [emailInput, setEmailInput] = useState(''), [historyFilter, setHistoryFilter] = useState('all');
  const [mailFromInput, setMailFromInput] = useState(''), [mailNameInput, setMailNameInput] = useState('Bühler 补料看板');
  // Testing credentials stay only in this page's memory. Never write them to browser storage.
  const [sessionApiToken, setSessionApiToken] = useState('');
  const [syncing, setSyncing] = useState(false), [online, setOnline] = useState(true), [focusLocation, setFocusLocation] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify = useCallback((value: Toast) => { setToast(value); if (toastTimer.current) clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(null), 6500); }, []);
  const refresh = useCallback(async (silent = false) => {
    const sequence = ++refreshSequence.current, knownBoard = boardRef.current;
    if (!silent) setSyncing(true);
    try {
      const response = await apiFetch('/api/state', { body: JSON.stringify({ layoutRevision: knownBoard.layoutRevision }) });
      const data = await readResponse<Snapshot>(response);
      if (!response.ok) throw new Error(data.error || '无法获取共享状态');
      const updated = data.board || knownBoard;
      const current = boardRef.current;
      if (updated.layoutRevision < current.layoutRevision ||
          (updated.layoutRevision === current.layoutRevision && sequence < lastRefresh.current)) return null;
      if (data.layoutRevision !== undefined && data.layoutRevision !== updated.layoutRevision) {
        throw new Error('无法同步新布局，请刷新页面。');
      }
      if (updated.layoutRevision !== current.layoutRevision) {
        setGroup('group-0');
        setDisplay('rack');
        setModal(old => old?.type === 'order' ? old : null);
        setFocusLocation('');
        setRefillSelection(new Map());
        setToast(null);
      }
      boardRef.current = updated;
      lastRefresh.current = Math.max(sequence, lastRefresh.current);
      setFrame({ board: updated, snapshot: data });
      setLoadError('');
      return data;
    }
    catch (e) { if (sequence >= lastRefresh.current) setLoadError(e instanceof Error ? e.message : '连接失败'); return null; }
    finally { if (!silent) setSyncing(false); }
  }, []);
  useEffect(() => {
    refresh();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') refresh(true); }, 30000);
    const up = () => { setOnline(true); refresh(); }, down = () => setOnline(false);
    window.addEventListener('online', up); window.addEventListener('offline', down); setOnline(navigator.onLine);
    return () => { clearInterval(timer); window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, [refresh]);
  useEffect(() => { if (snapshot && view === 'settings') { setEmailInput(snapshot.recipients); setMailFromInput(snapshot.mailFrom || ''); setMailNameInput(snapshot.mailFromName || 'Bühler 补料看板'); } }, [view, Boolean(snapshot)]);
  useEffect(() => { const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) setModal(null); }; window.addEventListener('keydown', esc); return () => window.removeEventListener('keydown', esc); }, [busy]);
  const bins = useMemo(() => new Map(snapshot?.bins.map(b => [b.location, b]) || []), [snapshot]);
  const itemsByLocation = useMemo(() => new Map(catalog.map(item => [item.BX, item])), [catalog]);
  const drawnLocations = useMemo(() => new Set(layout.flatMap(rack => rack.cells.map(cell => cell.location))), [layout]);
  const extras = catalog.length - drawnLocations.size;
  const pending = useMemo(() => catalog.filter(i => bins.get(i.BX)?.status === 'pending').sort((a, b) => compareLocation(a.BX, b.BX)), [bins, catalog]);
  const unassigned = pending.filter(i => !bins.get(i.BX)?.request_id), orders = snapshot?.orders || [];
  const awaitingEmail = orders.filter(o => o.status !== 'sent' && o.completed_count < o.items.length);
  const ready = Boolean(snapshot && !loadError && online && !busy);
  const canSendMail = Boolean(snapshot?.mailFrom && (snapshot.mailTokenConfigured || sessionApiToken.trim()));
  const bin = (loc: string) => bins.get(loc) || fullBin(loc);
  const pendingTargets = pending.map(item => {
    const { revision, request_id: requestId } = bin(item.BX);
    return { item, revision, requestId };
  });
  const selectedTargets = pendingTargets.filter(({ item, revision }) => refillSelection.get(item.BX) === revision);
  function switchMode(next: 'inspect' | 'refill') {
    if (next !== mode) setRefillSelection(new Map());
    setMode(next);
  }
  function toggleRefillSelection(location: string, revision: number, checked: boolean) {
    setRefillSelection(current => {
      const next = new Map(current);
      if (checked) next.set(location, revision);
      else next.delete(location);
      return next;
    });
  }
  function openConfirmation(scope: 'all' | 'selected') {
    setModal({ type: 'confirmBatch', scope, items: scope === 'all' ? pendingTargets : selectedTargets, layoutRevision });
  }
  async function confirmBatch(confirmation: Extract<Modal, { type: 'confirmBatch' }>) {
    if (!ready || !canRefill || mode !== 'refill' || !confirmation.items.length) return;
    setBusy('confirmBatch');
    const groups = new Map<string | null, RefillTarget[]>();
    for (const item of confirmation.items) {
      const group = groups.get(item.requestId) || [];
      group.push(item);
      groups.set(item.requestId, group);
    }
    let completed = 0;
    try {
      for (const items of groups.values()) {
        const response = await apiFetch('/api/bin/confirm', { method: 'POST', body: JSON.stringify({
          layoutRevision: confirmation.layoutRevision, operationId: operationId(),
          bins: items.map(({ item, revision }) => ({ location: item.BX, expectedRevision: revision }))
        }) });
        const data = await readResponse<{ count: number }>(response);
        if (!response.ok || data.count !== items.length) throw new Error(data.error || '未收到完整的确认结果。');
        completed += data.count;
      }
      notify({ text: `已确认补满 ${completed} 个料盒。` });
    } catch (e) {
      notify({ text: `已收到 ${completed}/${confirmation.items.length} 个成功结果。请刷新核对未确认的料盒。 ${e instanceof Error ? e.message : ''}`, error: true });
    } finally {
      setModal(null);
      await refresh(true);
      setBusy('');
    }
  }
  const matched = (item: Item) => { const q = search.toLowerCase().trim(); return (!q || [item.BX, item.L, item.M, item.N].some(s => s.toLowerCase().includes(q))) && (filter === 'all' || (filter === 'pending' ? bin(item.BX).status === 'pending' : bin(item.BX).status === 'full')); };
  const change = async (item: Item, target: 'pending' | 'full' | 'cancel', expected?: number) => {
    if (!ready) return; setBusy(item.BX);
    try {
      const response = await apiFetch('/api/bin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: item.BX, target, layoutRevision, expectedRevision: expected ?? bin(item.BX).revision, operationId: operationId(), operator: operatorName }) }), data = await readResponse<{ ok: boolean }>(response);
      if (!response.ok) throw new Error(data.error);
      const state = await refresh(true), changed = state?.bins.find(b => b.location === item.BX); setFocusLocation(item.BX);
      notify({ text: `${item.BX} · ${target === 'pending' ? '已标记待补料' : target === 'full' ? '已确认补满' : '已撤销报缺'}`, ...(target === 'pending' && changed ? { undo: () => change(item, 'cancel', changed.revision) } : {}) }); setModal(null);
    } catch (e) { notify({ text: e instanceof Error ? e.message : '操作失败', error: true }); await refresh(true); }
    finally { setBusy(''); }
  };
  const itemAction = (item: Item) => { if (!ready) return; setFocusLocation(item.BX); if (mode === 'inspect' && bin(item.BX).status === 'full') change(item, 'pending'); else setModal({ type: 'item', item }); };
  const createOrder = async () => {
    if (!ready || !canDispatch || !unassigned.length) return; setBusy('create');
    try {
      const response = await apiFetch('/api/requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ locations: unassigned.map(i => i.BX), layoutRevision, recipients: snapshot?.recipients || '', operator: operatorName, operationId: new Date().toISOString().slice(0, 10).replaceAll('-', '') + '-' + operationId().slice(0, 8) }) }), data = await readResponse<{ id: string }>(response);
      if (!response.ok) throw new Error(data.error);
      const state = await refresh(true), order = state?.orders.find(o => o.id === data.id); setModal(order ? { type: 'order', order } : null); notify({ text: '补料单已生成。请核对后发送邮件。' });
    } catch (e) { notify({ text: e instanceof Error ? e.message : '生成失败', error: true }); await refresh(true); }
    finally { setBusy(''); }
  };
  const sendOrder = async (order: Order) => {
    if (!ready || !canDispatch || !canSendMail || !snapshot || !(snapshot.recipients || order.recipient)) return; setBusy('send');
    try {
      const response = await apiFetch(`/api/requests/${encodeURIComponent(order.id)}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recipients: order.recipient || snapshot.recipients, apiToken: sessionApiToken.trim() || undefined }) }), data = await readResponse<{ ok: boolean; warning?: string }>(response);
      if (!response.ok) throw new Error(data.error);
      const state = await refresh(true), updated = state?.orders.find(o => o.id === order.id); if (updated) setModal({ type: 'order', order: updated }); notify({ text: data.warning || '邮件已提交 MailerSend。请检查公司邮箱收件结果。' });
    } catch (e) { notify({ text: e instanceof Error ? e.message : '发送失败', error: true }); const state = await refresh(true), updated = state?.orders.find(o => o.id === order.id); if (updated) setModal({ type: 'order', order: updated }); }
    finally { setBusy(''); }
  };
  const saveSettings = async () => {
    if (!ready) return; setBusy('settings');
    try { const response = await apiFetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recipients: emailInput, mailFrom: mailFromInput, mailFromName: mailNameInput }) }), data = await readResponse<{ recipients: string }>(response); if (!response.ok) throw new Error(data.error); setEmailInput(data.recipients); await refresh(true); notify({ text: '地址设置已保存；测试Token仅在本次页面中使用，刷新后需重新填写。' }); }
    catch (e) { notify({ text: e instanceof Error ? e.message : '保存失败', error: true }); } finally { setBusy(''); }
  };
  const exportItems = (items: Item[], name: string) => { saveFile(`${name}.csv`, csv(items), 'text/csv;charset=utf-8'); notify({ text: '补料清单已导出，包含 L / M / N / BI / BX 五列' }); };
  const openDraft = (order: Order) => { draft(order, order.recipient || snapshot?.recipients || ''); notify({ text: '邮件草稿已下载。请在邮箱中核对收件人并发送；系统仍保留“未发邮件”状态。' }); };
  const chooseView = (v: View) => { setView(v); setModal(null); };
  const groups = Array.from({ length: Math.ceil(layout.length / 5) }, (_, i) => {
    const racks = layout.slice(i * 5, i * 5 + 5);
    const label = racks.length === 1 ? rackLabel(racks[0].rack) : rackLabel(racks[0].rack) + '–' + rackLabel(racks[racks.length - 1].rack);
    return { id: `group-${i}`, label: label + ' 号', racks };
  });
  const selectedRacks = group === 'all' ? layout : groups.find(g => g.id === group)?.racks || layout.filter(r => String(r.rack) === group);
  const listed = catalog.filter(item => matched(item) && (group !== 'extra' || !drawnLocations.has(item.BX)));
  const nav = [
    { id: 'board', label: '货架看板', icon: LayoutGrid, adminOnly: false },
    { id: 'orders', label: '补料清单', icon: ClipboardList, adminOnly: false },
    { id: 'five-s', label: '5S 记录', icon: FileCheck2, adminOnly: false },
    { id: 'history', label: '操作记录', icon: History, adminOnly: false },
    { id: 'layout', label: '货架配置', icon: FileSpreadsheet, adminOnly: true },
    { id: 'customer-demo', label: '客户需求演示', icon: SlidersHorizontal, adminOnly: false },
    { id: 'access', label: '人员与权限', icon: ShieldCheck, adminOnly: true },
    { id: 'face-profile', label: '我的登录方式', icon: ScanFace, adminOnly: false },
    { id: 'arims', label: 'ARIMS 接口调试', icon: Code2, adminOnly: true }
  ] as const;
  const orderLabel = (o: Order) => o.status === 'sent' ? '已提交邮件' : o.status === 'sending' ? '发送中 · 待核实' : o.status === 'uncertain' ? '发送结果待核实' : o.status === 'partial' ? '部分已提交' : o.status === 'failed' ? '发送失败' : '未发邮件';
  const publishLayout = async (payload: LayoutPublish) => {
    if (!ready || !isAdmin) throw new Error('共享状态尚未就绪，请刷新后发布。');
    setBusy('layout');
    try {
      const response = await apiFetch('/api/layout', { method: 'POST', body: JSON.stringify({ ...payload, operationId: operationId() }) });
      const data = await readResponse<{ layoutRevision: number }>(response);
      if (!response.ok) {
        if (response.status === 409) await refresh(true);
        throw new Error(data.error || '布局发布未完成。');
      }
      await refresh(true);
      if (boardRef.current.layoutRevision >= data.layoutRevision) {
        chooseView('board');
        notify({ text: `货架布局 v${data.layoutRevision} 已发布。` });
      } else notify({ text: '布局已发布，请刷新共享状态读取新版本。' });
    } finally { setBusy(''); }
  };
  const openOrderItem = (item: Item) => {
    const active = itemsByLocation.get(item.BX);
    if (active?.L === item.L) setModal({ type: 'item', item: active });
    else notify({ text: `${item.BX} 已调整，本单保留原物料信息。` });
  };

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div>BOSSARD<small>SMART FACTORY LOGISTICS</small></div></div>
      <div className="workspace"><span className="workspace-avatar">Bü</span><div>Bühler Wuxi<small>线边仓物料管理</small></div><ChevronDown size={15} /></div>
      <div className="nav-caption">工作空间</div><nav>{nav.filter(item => isAdmin || !item.adminOnly).map(({ id, label, icon: Icon }) => <button key={id} aria-label={label} className={view === id ? 'active' : ''} onClick={() => chooseView(id)}><Icon size={19} />{label}{id === 'orders' && pending.length > 0 && <b>{pending.length}</b>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="side-note"><ShieldCheck size={18} /><span>电子看板 · 持续追踪<small>从巡检到补料，每一步有记录</small></span></div><button aria-label="使用说明" className={view === 'help' ? 'active' : ''} onClick={() => chooseView('help')}><CircleHelp size={18} />使用说明</button><button aria-label="终端与邮件设置" className={view === 'settings' ? 'active' : ''} onClick={() => chooseView('settings')}><Settings size={18} />终端与邮件设置</button><div className="sidebar-version"><i />BOS · 电子补料 V{__APP_VERSION__}</div></div>
    </aside>
    <div className="app-content">
      <header className="topbar"><div className="breadcrumb">智能物流 <ChevronRight size={14} /><span>Bühler 线边仓</span></div><div className="header-right"><span className={`sync-label ${loadError || !online ? 'offline' : ''}`}><i />{!online ? '网络已断开' : loadError ? '连接异常' : snapshot ? '共享状态已同步' : '正在连接'}</span><button className="icon-button" title="刷新共享状态" aria-label="刷新共享状态" onClick={() => refresh()} disabled={syncing}><RefreshCw size={17} className={syncing ? 'spin' : ''} /></button><span className="divider" /><div className="user-avatar">{operatorName ? operatorName.slice(0, 1) : '现'}</div><span className="operator-label">{operatorName || '现场终端'}</span><button className="logout-button" onClick={onLogout}>退出</button></div></header>
      <main>
        <div className="page-heading"><div><div className="eyebrow">LINE-SIDE REPLENISHMENT</div><h1>{view === 'board' ? '线边仓电子补料' : view === 'five-s' ? '5S 记录' : view === 'customer-demo' ? '客户需求演示' : view === 'orders' ? '补料清单' : view === 'history' ? '操作记录' : view === 'settings' ? '终端与邮件设置' : view === 'layout' ? '货架配置' : view === 'access' ? '人员与权限' : view === 'face-profile' ? '我的登录方式' : view === 'arims' ? 'ARIMS 接口调试' : '使用说明'}</h1><p>{view === 'board' ? '按现场位置巡检，轻点料盒报缺，让每一次补料清晰可见。' : view === 'five-s' ? '按货架登记完成、检查和整改情况。' : view === 'customer-demo' ? '切换角色，试用补料与 VMI、用量预警和样机备料。' : view === 'orders' ? '集中处理补料需求，导出拣料清单并发送邮件。' : view === 'history' ? '查看报缺、清单生成与补料确认的完整记录。' : view === 'settings' ? '设置操作员与补料通知，连接日常补料流程。' : view === 'layout' ? '导入物料与位置，核对预览后发布到各终端。' : view === 'arims' ? '调试 ARIMS 登录与库存查询，核对 XML 和 HTTP 响应。' : '熟悉电子补料流程，和纸质缺料卡说再见。'}</p></div>{view === 'board' && <div className="mode-switch"><button className={mode === 'inspect' ? 'selected' : ''} disabled={!canInspect} onClick={() => switchMode('inspect')}><Search size={16} />巡检报缺</button><button className={mode === 'refill' ? 'selected refill' : ''} disabled={!canRefill} onClick={() => switchMode('refill')}><PackageCheck size={17} />补料确认</button></div>}</div>
        {(loadError || !online) && <div className="error-banner"><WifiOff size={18} /><span>{!online ? '当前终端已离线。请恢复网络后继续操作，以确保料盒状态同步。' : loadError + ' 当前显示为上次读取的数据，操作已暂停。'}</span><button onClick={() => refresh()}>重新连接</button></div>}
        {isAdmin && <div hidden={view !== 'arims'}><ArimsDebugger /></div>}
        {isAdmin && view === 'access' && <AccessSettings />}
        {view === 'face-profile' && <FaceProfile actor={actor} onLogout={onLogout} />}
        {isAdmin && view === 'layout' && <LayoutConfigurator board={board} bins={snapshot?.bins || []} ready={ready} onPublish={publishLayout} />}
        {view === 'board' && <>
          <div className="stats-grid"><div className="stat"><div><span>图中料盒</span><strong>{drawnLocations.size}<small>个</small></strong><p>{layout.length} 组货架 · 已关联物料</p></div><span className="stat-icon blue"><Warehouse size={22} /></span></div><div className="stat"><div><span>待补料盒</span><strong className="amber-text">{snapshot ? pending.length : '—'}<small>个</small></strong><p>已标记缺料，等待补满</p></div><span className="stat-icon orange"><Box size={22} /></span></div><div className="stat"><div><span>待生成清单</span><strong>{snapshot ? unassigned.length : '—'}<small>个</small></strong><p>{awaitingEmail.length ? `另有 ${awaitingEmail.length} 份清单待发邮件` : '本轮新标记的缺料需求'}</p></div><span className="stat-icon violet"><ClipboardList size={22} /></span></div><div className="stat"><div><span>今日已补满</span><strong className="green-text">{snapshot ? snapshot.todayCompleted : '—'}<small>次</small></strong><p>以终端确认记录为准</p></div><span className="stat-icon teal"><CheckCheck size={23} /></span></div></div>
          <div className={`mode-notice ${mode}`}><span className="notice-icon">{mode === 'inspect' ? <Search size={17} /> : <PackageCheck size={19} />}</span><span><b>{mode === 'inspect' ? '巡检模式' : '补料模式'}</b>{mode === 'inspect' ? '查看实物余量，点击蓝色料盒即可标记待补料；巡检完成后统一生成清单。' : '实物补料后，可单个确认，也可在待补料清单勾选多项。'}</span><span className="manual-tag">人工目视判断</span></div>
          <div className="board-layout">
            <section className="board-card"><div className="section-top"><div><h2>现场货架看板 <span className="count-chip">{layout.length} 组</span></h2><p>按当前货架配置展示 · 从左至右、从上至下</p></div><div className="view-switch"><button title="货架视图" aria-label="货架视图" className={display === 'rack' ? 'selected' : ''} onClick={() => { setDisplay('rack'); if (group === 'extra') setGroup('group-0'); }}><LayoutGrid size={17} /></button><button title="物料列表" aria-label="物料列表" className={display === 'list' ? 'selected' : ''} onClick={() => setDisplay('list')}><List size={18} /></button></div></div>
              <div className="board-toolbar">
                <div className="group-tabs">
                  {groups.map(g => <button key={g.id} className={group === g.id ? 'selected' : ''} onClick={() => { setGroup(g.id); setDisplay('rack'); }}>{g.label}</button>)}
                  {groups.length > 1 && <button className={group === 'all' ? 'selected' : ''} onClick={() => { setGroup('all'); setDisplay('rack'); }}>全部货架</button>}
                  {extras > 0 && <button className={group === 'extra' ? 'selected' : ''} onClick={() => { setGroup('extra'); setDisplay('list'); }}>图外库位 <span>{extras}</span></button>}
                </div>
                <select aria-label="单独查看货架" value={/^\d+$/.test(group) ? group : ''} onChange={e => { setGroup(e.target.value || 'group-0'); setDisplay('rack'); }}>
                  <option value="">单架查看</option>
                  {layout.map(r => <option key={r.rack} value={r.rack}>{rackLabel(r.rack)} 号货架</option>)}
                </select>
              </div>
              <div className="search-row"><label className="search-field"><Search size={16} /><input aria-label="搜索物料或库位" value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索库位、物料号、名称或规格…" />{search && <button aria-label="清除搜索" onClick={() => setSearch('')}><X size={14} /></button>}</label><label className="filter-select"><SlidersHorizontal size={15} /><select value={filter} aria-label="筛选料盒状态" onChange={e => setFilter(e.target.value)}><option value="all">全部状态</option><option value="pending">仅待补料</option><option value="full">仅满料</option></select></label></div>
              {display === 'rack' ? <>
                <RackScene racks={selectedRacks} items={itemsByLocation} bins={bins} ready={ready} match={matched} focused={focusLocation} busy={busy} zoom={zoom} onItem={itemAction} />
                <div className="canvas-bottom"><div className="legend"><span><i className="blue-dot" />满料</span><span><i className="orange-dot" />待补料</span><span className="legend-tip">合并库位按一个料盒管理</span></div><div className="zoom-controls"><button aria-label="缩小货架" onClick={() => setZoom(Math.max(1, zoom - .2))} disabled={zoom <= 1}><ZoomOut size={15} /></button><span>{Math.round(zoom * 100)}%</span><button aria-label="放大货架" onClick={() => setZoom(Math.min(2, zoom + .2))} disabled={zoom >= 2}><ZoomIn size={15} /></button></div></div>
              </> : <>
                <div className="list-scope-note"><Info size={15} />{group === 'extra' ? `图外库位共 ${extras} 个，可在这里报缺或确认补满。` : `物料总表共 ${catalog.length} 个库位，当前筛选 ${listed.length} 个。`}</div>
                <MaterialTable items={listed} bins={bins} onItem={item => setModal({ type: 'item', item })} onAction={itemAction} mode={mode} disabled={!ready} />
              </>}
              <div className="board-footnote"><Info size={14} />状态由人工巡检与补料确认更新，不代表实时库存数量。{referenceImage && <button onClick={() => chooseView('help')}>查看原始布局 <ExternalLink size={12} /></button>}</div>
            </section>
            <aside className="queue-card">
              <div className="queue-header">
                <div><ClipboardList size={18} /><h2>待补料清单</h2><span>{pending.length}</span></div>
                <small>{mode === 'refill' ? '勾选已补满的料盒后提交确认' : '当前全部待补库位'}</small>
              </div>
              {pending.length ? (
                <div className="queue-list">
                  {pendingTargets.map(({ item, revision }) => (
                    <div className="queue-row" key={item.BX}>
                      {mode === 'refill' && (
                        <label className="queue-select">
                          <input
                            type="checkbox"
                            aria-label={`选择库位 ${item.BX}`}
                            checked={refillSelection.get(item.BX) === revision}
                            disabled={!ready || !canRefill}
                            onChange={event => toggleRefillSelection(item.BX, revision, event.target.checked)}
                          />
                        </label>
                      )}
                      <button className={`queue-item ${focusLocation === item.BX ? 'active' : ''}`} onClick={() => setModal({ type: 'item', item })}>
                        <span className="queue-location">{item.BX}</span>
                        <span className="queue-material"><b>{item.L}</b><small>{item.N}</small><em>{bin(item.BX).request_id ? '已生成清单' : '新报缺'}</em></span>
                        <span className="queue-qty">{item.BI}<small>补料数</small></span>
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="queue-empty">
                  <div><PackageCheck size={35} strokeWidth={1.4} /><span><Check size={12} /></span></div>
                  <h3>{snapshot ? '当前没有待补料盒' : '正在读取料盒状态'}</h3>
                  <p>{mode === 'inspect' ? '点击货架上的料盒标记缺料，需求会自动汇总到这里。' : '所有已报缺料盒补满后，清单会自动清空。'}</p>
                </div>
              )}
              <div className="queue-action">
                {mode === 'refill' ? (
                  <>
                    <div><span>已选择</span><b>{selectedTargets.length}<small> 个料盒</small></b></div>
                    <button className="primary-button success-button" disabled={!ready || !canRefill || !selectedTargets.length} onClick={() => openConfirmation('selected')}>
                      <CheckCheck size={17} />确认所选补满
                    </button>
                    <button className="secondary-button" disabled={!ready || !canRefill || !pendingTargets.length} onClick={() => openConfirmation('all')}>
                      全部确认补满（{pending.length}）
                    </button>
                  </>
                ) : (
                  <>
                    <div><span>本轮待生成</span><b>{unassigned.length}<small> 个料盒</small></b></div>
                    <button className="primary-button" disabled={!ready || !canDispatch || !unassigned.length} onClick={() => setModal({ type: 'review' })}><FileCheck2 size={17} />结束巡检，生成清单<ArrowRight size={16} /></button>
                    <button className="secondary-button" disabled={!snapshot || !pending.length} onClick={() => exportItems(pending, 'Buhler_当前待补料清单')}><Download size={16} />导出当前补料清单</button>
                    {awaitingEmail.length > 0 && <button className="awaiting-link" onClick={() => chooseView('orders')}><Mail size={14} />{awaitingEmail.length} 份清单待发邮件<ChevronRight size={13} /></button>}
                  </>
                )}
                <small><ShieldCheck size={12} />确认补满前，需求持续保留</small>
              </div>
            </aside>
          </div><div className="data-source"><FileSpreadsheet size={14} /><span>数据来源：{board.layoutSource}</span><span>{catalog.length} 条物料 · 布局 v{layoutRevision}</span></div>
        </>}
        {view === 'five-s' && <FiveSBoard key={layoutRevision} racks={layout.map(rack => rack.rack)} layoutRevision={layoutRevision}
          operatorName={actor.label} role={actor.role} online={online} />}
        {view === 'customer-demo' && <CustomerDemo key={layoutRevision} catalog={catalog} layout={layout}
          initialRole={actor.role === 'inspector' ? 'lead' : actor.role === 'operator' ? 'worker' : actor.role} />}
        {view === 'orders' && <><div className="order-overview"><div><span>待补料盒</span><strong>{pending.length}<small> 个</small></strong></div><div><span>待生成清单</span><strong>{unassigned.length}<small> 个</small></strong></div><div><span>待发邮件</span><strong>{awaitingEmail.length}<small> 份</small></strong></div><div className="order-tools"><button className="secondary-button" disabled={!snapshot || !pending.length} onClick={() => exportItems(pending, 'Buhler_当前待补料清单')}><Download size={16} />导出待补清单</button><button className="primary-button" disabled={!ready || !canDispatch || !unassigned.length} onClick={() => setModal({ type: 'review' })}><Plus size={16} />生成补料单</button></div></div>{!canSendMail && <div className="mail-banner"><Mail size={20} /><div><b>自动邮件待配置</b><p>请到设置中填写 MailerSend 测试发件地址、公司收件邮箱和本次 API Token。</p></div><button onClick={() => chooseView('settings')}>前往设置<ArrowRight size={15} /></button></div>}<section className="surface"><div className="section-top"><h2>补料单记录 <span className="count-chip">{orders.length}</span></h2><small>最近100份 · 状态持续保留</small></div>{orders.length ? <div className="order-list">{orders.map(o => <div className="order-row" key={o.id}><span className="order-file"><ClipboardList size={23} /></span><div className="order-title"><button onClick={() => setModal({ type: 'order', order: o })}>{shortId(o.id)}<ChevronRight size={15} /></button><small>{fmt(o.created_at)} · {o.created_by} · {o.items.length} 个料盒</small></div><div className="order-progress"><span>补料进度 <b>{o.completed_count}/{o.items.length}</b></span><div><i style={{ width: `${o.completed_count / o.items.length * 100}%` }} /></div></div><span className={`pill ${o.completed_count === o.items.length ? 'green' : 'amber'}`}>{o.completed_count === o.items.length ? '补料完成' : '等待补料'}</span><span className={`mail-status ${o.status === 'sent' ? 'green-text' : ''}`}><Mail size={14} />{orderLabel(o)}</span><button className="icon-button" title="导出本单CSV" aria-label={`导出 ${shortId(o.id)}`} onClick={() => exportItems(o.items, o.id)}><Download size={17} /></button><button className="secondary-button small" onClick={() => setModal({ type: 'order', order: o })}>查看详情</button></div>)}</div> : <div className="big-empty"><ClipboardList size={43} strokeWidth={1.3} /><h3>还没有补料单</h3><p>先在货架看板中标记缺料，再结束巡检并生成补料清单。</p><button className="primary-button" onClick={() => chooseView('board')}>前往货架看板<ArrowRight size={16} /></button></div>}</section></>}
        {view === 'history' && <section className="surface"><div className="section-top"><div><h2>操作流水</h2><p>最近150条操作 · 服务器统一记录</p></div><select aria-label="筛选操作类型" value={historyFilter} onChange={e => setHistoryFilter(e.target.value)}><option value="all">全部操作</option><option value="pending">标记待补</option><option value="full">确认补满</option><option value="cancel">撤销报缺</option><option value="request">生成清单</option><option value="email">发送邮件</option><option value="layout">发布货架布局</option></select></div><div className="timeline">{snapshot?.events.filter(e => historyFilter === 'all' || e.action === historyFilter).length ? snapshot.events.filter(e => historyFilter === 'all' || e.action === historyFilter).map(e => <div className="timeline-row" key={e.id}><span className={`timeline-icon ${e.action === 'full' ? 'teal' : e.action === 'pending' ? 'orange' : 'blue'}`}>{e.action === 'full' ? <PackageCheck size={18} /> : e.action === 'request' ? <ClipboardList size={18} /> : e.action === 'email' ? <Mail size={18} /> : e.action === 'cancel' ? <Undo2 size={18} /> : <Box size={18} />}</span><div><b>{({ pending: '标记待补料', full: '确认补满', cancel: '撤销报缺', request: '生成补料单', email: '提交补料邮件', layout: '发布货架布局' } as Record<string, string>)[e.action] || e.action}{e.location && <span className="mono"> · {e.location}</span>}</b><p>{e.location ? itemsByLocation.get(e.location)?.L || e.detail : e.detail}</p></div><span className="timeline-user">{e.operator}</span><time>{fmt(e.created_at)}</time></div>) : <div className="big-empty"><History size={42} strokeWidth={1.4} /><h3>暂无操作记录</h3><p>巡检报缺、补料与清单操作会记录在这里。</p></div>}</div></section>}
        {view === 'settings' && <div className="settings-grid">
          <section className="surface settings-form"><div className="section-top"><h2><Settings size={18} />终端与地址设置</h2></div><div className="form-body">
            <label>当前终端操作员<input aria-label="操作员姓名" value={operatorName} readOnly /><small>操作记录使用当前登录账号，由后台确认身份。</small></label>
            <label>MailerSend 测试发件邮箱<input type="email" aria-label="发件邮箱" value={mailFromInput} onChange={e => setMailFromInput(e.target.value)} placeholder="复制 MailerSend 沙盒示例中的 from.email" /><small>请复制平台给出的完整测试发件地址，不能用私人注册邮箱代替。</small></label>
            <label>发件显示名<input aria-label="发件显示名" maxLength={80} value={mailNameInput} onChange={e => setMailNameInput(e.target.value)} placeholder="例如：Bühler 补料看板" /></label>
            <label>补料通知收件邮箱<textarea aria-label="收件邮箱" value={emailInput} onChange={e => setEmailInput(e.target.value)} placeholder="多个邮箱用分号、逗号或换行分隔" rows={2} /><small>最多10个，系统逐人发送相同清单。测试域名与收件人限制以你的MailerSend账号为准。已有补料单保留生成时的收件人。</small></label>
            <button className="primary-button" disabled={!ready || !isAdmin} onClick={saveSettings}>{busy === 'settings' ? <Loader2 size={16} className="spin" /> : <Check size={16} />}{isAdmin ? '保存地址设置' : '地址由管理员维护'}</button>
          </div></section>
          <section className="surface mail-channel-form"><div className="section-top"><h2><Mail size={18} />MailerSend 测试通道</h2><span className={`pill ${canSendMail ? 'green' : 'amber'}`}>{canSendMail ? '参数已齐全' : '待填写参数'}</span></div><div className="form-body">
            <p className="setting-description">直接在这里填写你的沙盒 API Token。发送时由网站后台逐人调用 MailerSend，每封邮件均附上相同的补料CSV清单。</p>
            <label>API Token（仅本次页面有效）<input aria-label="MailerSend API Token" name="mailersend-testing-token" maxLength={8192} type="password" autoComplete="off" spellCheck={false} value={sessionApiToken} onChange={e => setSessionApiToken(e.target.value)} placeholder="在此粘贴 MailerSend API Token" /><small>只保留在当前页面内存中，发送时通过本站后台使用。不会写入数据库、浏览器存储或源码；刷新页面后需要重新填写。</small></label>
            <div className="token-state"><span className={`pill ${sessionApiToken.trim() || snapshot?.mailTokenConfigured ? 'green' : 'amber'}`}>{sessionApiToken.trim() ? '本次Token已填写' : snapshot?.mailTokenConfigured ? '使用后台密钥' : '尚未填写Token'}</span>{sessionApiToken && <button className="text-button" onClick={() => setSessionApiToken('')}>清除本次Token</button>}</div>
            <div className="feature-line"><CheckCircle2 size={17} /><span>正文与CSV附件：已接入</span></div>
            <div className="feature-line"><Mail size={17} /><span>{canSendMail ? '参数已齐全，可前往补料单发送' : '填写Token并保存发件邮箱后，即可发送'}</span></div>
            <button className="primary-button" disabled={!canSendMail || !ready} onClick={() => chooseView('orders')}>前往补料单<ArrowRight size={16} /></button>
            <div className="setting-note"><Info size={16} /><p>此处不会自动发邮件。请在补料单详情中核对公司收件邮箱，再点击“发送补料邮件”。“已提交邮件”表示平台接收，实际送达请在公司邮箱确认。</p></div>
          </div></section>
        </div>}
        {view === 'help' && <><div className="help-steps">{[{ no: '01', title: '巡线查看，手动报缺', text: '在“巡检报缺”模式检查实物余量，点击对应库位。蓝色料盒变为橙色待补状态。', icon: Search }, { no: '02', title: '统一生成补料清单', text: '巡检完成后生成清单。按 BX 关联物料，自动整理 L、M、N、BI、BX 五列。', icon: ClipboardList }, { no: '03', title: '通知补料人员', text: '核对后发送邮件，或导出 CSV、下载带附件的邮件草稿，交给补料人员拣料。', icon: Mail }, { no: '04', title: '对应补料，确认补满', text: '补料人员切换“补料确认”模式，可确认单个、所选或全部已补满的料盒。', icon: PackageCheck }].map(s => <section className="surface help-step" key={s.no}><span>{s.no}</span><s.icon size={26} /><h3>{s.title}</h3><p>{s.text}</p></section>)}</div>{referenceImage && <section className="surface"><div className="section-top"><div><h2>现场原始货架布局</h2><p>图片包含1–10号货架；合并地址只对应一条物料和一项补料需求。</p></div></div><div className="reference-image"><img src={referenceImage} alt="客户现场1至10号货架原始布局图" /></div></section>}<section className="surface mapping-help"><div className="section-top"><h2>物料关联规则</h2></div><div className="mapping-grid">{headings.map((h, i) => <div key={h}><span>{['L', 'M', 'N', 'BI', 'BX'][i]}</span><b>{h.replace(/ \(.*\)/, '')}</b><small>{['Customer Item No.', 'Description', 'Dimension', 'Reorder QTY / Used', 'Phys. Addr.'][i]}</small></div>)}</div><div className="help-notes"><p><Info size={16} /><span>BI 为原表中的标准补料数量，保留原值，不是实时库存或系统自动计算的缺料量。</span></p><p><Info size={16} /><span>当前共有 {catalog.length} 个库位，其中 {drawnLocations.size} 个显示在货架图，{extras} 个可通过图外列表操作。</span></p><p><Info size={16} /><span>首次启用时默认显示满料，请以实物巡检结果更新。此版本需要联网同步；数据连接异常时暂停状态修改。</span></p></div></section></>}
      </main><footer className="app-footer"><span>BOSSARD · Proven Productivity</span><span>Bühler Wuxi 线边仓电子补料系统</span><span>{snapshot ? `最近同步 ${fmt(snapshot.serverTime)} · UTC+8` : '等待同步'}</span></footer>
    </div>
    {modal && <div className="modal-backdrop" onClick={() => !busy && setModal(null)}><section className={`modal ${modal.type !== 'item' ? 'wide-modal' : ''}`} role="dialog" aria-modal="true" aria-label={modal.type === 'item' ? '料盒详情' : modal.type === 'review' ? '生成补料单' : modal.type === 'confirmBatch' ? (modal.scope === 'all' ? '全部确认补满' : '确认所选补满') : '补料单详情'} onClick={e => e.stopPropagation()}><button className="modal-close icon-button" aria-label="关闭详情" onClick={() => setModal(null)} disabled={!!busy}><X size={20} /></button>
      {modal.type === 'item' && (() => { const item = modal.item, b = bin(item.BX); return <><div className={`detail-icon ${b.status === 'pending' ? 'orange' : 'blue'}`}><Box size={28} /></div><div className="modal-eyebrow">料盒详情 · {item.BX.split('/')[0]} 号货架</div><h2 className="modal-title">{item.BX}<span className={`pill ${b.status === 'pending' ? 'amber' : 'green'}`}><i />{b.status === 'pending' ? '待补料' : '满料'}</span></h2><dl className="item-details"><dt>客户物料号 <small>L</small></dt><dd className="mono">{item.L}</dd><dt>物料描述 <small>M</small></dt><dd>{item.M}</dd><dt>规格 <small>N</small></dt><dd>{item.N}</dd><dt>补料数量 <small>BI</small></dt><dd><b className="detail-qty">{item.BI}</b><small>原表标准补料数量</small></dd><dt>料盒位置 <small>BX</small></dt><dd className="mono">{item.BX}</dd></dl>{b.marked_at && b.status === 'pending' && <div className="detail-meta"><Clock3 size={14} />{fmt(b.marked_at)} 标记待补{b.request_id && <span> · 已生成清单</span>}</div>}<div className="modal-actions">{mode === 'refill' && b.status === 'pending' ? <><div className="confirm-hint"><Info size={16} />请确认已将上述物料补至此料盒。</div><button className="primary-button success-button" disabled={!ready || !canRefill} onClick={() => change(item, 'full')}><CheckCheck size={18} />确认已补满</button></> : b.status === 'full' ? <button className="primary-button" disabled={!ready || !canInspect} onClick={() => change(item, 'pending')}><Plus size={17} />标记待补料</button> : <><button className="primary-button" disabled={!canRefill} onClick={() => switchMode('refill')}><PackageCheck size={17} />切换补料确认模式</button>{canCancel(b) && <button className="secondary-button" disabled={!ready} onClick={() => change(item, 'cancel')}><Undo2 size={16} />撤销本次报缺</button>}</>}</div></>; })()}
      {modal.type === 'confirmBatch' && <><div className="modal-eyebrow">补料确认</div><h2 className="modal-title">{modal.scope === 'all' ? '全部确认补满' : '确认所选补满'}</h2><p className="modal-subtitle">将以下 {modal.items.length} 个待补料盒确认补满。{modal.scope === 'all' && '范围包含全部货架和图外库位。'}请核对已完成实物补料。</p><div className="table-scroll"><table><thead><tr><th>料盒位置</th><th>客户物料号</th><th>规格</th><th className="number">补料数量</th></tr></thead><tbody>{modal.items.map(({ item }) => <tr key={item.BX}><td>{item.BX}</td><td>{item.L}</td><td>{item.N}</td><td className="number">{item.BI}</td></tr>)}</tbody></table></div><div className="modal-bottom"><button className="secondary-button" disabled={!!busy} onClick={() => setModal(null)}>取消</button><button className="primary-button success-button" disabled={!ready || !canRefill} onClick={() => confirmBatch(modal)}>{busy === 'confirmBatch' ? <Loader2 size={16} className="spin" /> : <CheckCheck size={17} />}确认已补满</button></div></>}
      {modal.type === 'review' && <><div className="modal-eyebrow">结束本轮巡检</div><h2 className="modal-title">生成补料单</h2><p className="modal-subtitle">汇总 {unassigned.length} 个新报缺料盒，按库位排序，自动读取五列物料信息。</p><div className="recipient-summary"><Mail size={17} /><div><small>补料通知收件人</small><b>{snapshot?.recipients || '尚未设置 · 生成后仍可导出或下载草稿'}</b></div><button onClick={() => chooseView('settings')}>设置</button></div><MaterialTable items={unassigned} bins={bins} onItem={item => setModal({ type: 'item', item })} /><div className="modal-bottom"><span><Info size={15} />生成清单后料盒继续保持待补状态。</span><button className="primary-button" disabled={!ready || !canDispatch || !unassigned.length} onClick={createOrder}>{busy === 'create' ? <Loader2 size={16} className="spin" /> : <FileCheck2 size={17} />}生成补料单<ArrowRight size={16} /></button></div></>}
      {modal.type === 'order' && (() => { const order = orders.find(o => o.id === modal.order.id) || modal.order; return <><div className="modal-eyebrow">REPLENISHMENT ORDER</div><h2 className="modal-title">补料单详情 <span className={`pill ${order.status === 'sent' ? 'green' : 'amber'}`}>{orderLabel(order)}</span></h2><p className="modal-subtitle mono">{order.id}</p><div className="order-detail-bar"><span><Clock3 size={15} />{fmt(order.created_at)}</span><span>{order.created_by}</span><span>{order.items.length} 个料盒</span><b>已补满 {order.completed_count}/{order.items.length}</b></div><div className="recipient-summary"><Mail size={17} /><div><small>通知收件人</small><b>{order.recipient || snapshot?.recipients || '尚未设置收件邮箱'}</b></div><button onClick={() => chooseView('settings')}>设置</button></div><MailDeliveryResults order={order} />{order.error && <div className="error-banner">{order.error}</div>}{!canSendMail && <div className="draft-notice"><Info size={16} /><span>请先到“终端与邮件设置”填写 MailerSend 测试参数。仍可导出CSV或下载邮件草稿。</span></div>}<MaterialTable items={order.items} bins={bins} onItem={openOrderItem} /><div className="modal-bottom order-buttons"><button className="secondary-button" onClick={() => exportItems(order.items, order.id)}><Download size={16} />导出 CSV</button><button className="secondary-button" onClick={() => openDraft(order)}><ArrowDownToLine size={16} />下载邮件草稿</button><button className="primary-button" disabled={!ready || !canDispatch || !canSendMail || !(order.recipient || snapshot?.recipients) || !['prepared', 'failed', 'partial'].includes(order.status)} onClick={() => sendOrder(order)}>{busy === 'send' ? <Loader2 size={16} className="spin" /> : <Send size={16} />}{order.status === 'sent' ? '已提交邮件' : order.status === 'partial' ? '重试未成功的收件人' : '发送补料邮件'}</button></div><p className="send-note">系统逐人发送相同清单；重试会跳过已提交的收件人，结果未知时先核实。邮件状态与料盒状态独立，补料人员须按实际补料结果确认补满。</p></>; })()}
    </section></div>}
    {toast && <div className={`toast ${toast.error ? 'error-toast' : ''}`} role="status">{toast.error ? <Info size={19} /> : <CheckCircle2 size={19} />}<span>{toast.text}</span>{toast.undo && <button onClick={toast.undo}>撤销</button>}<button className="toast-close" aria-label="关闭通知" onClick={() => setToast(null)}><X size={16} /></button></div>}
  </div>;
}
