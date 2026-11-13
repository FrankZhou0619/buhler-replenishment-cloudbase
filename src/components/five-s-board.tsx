import { useEffect, useState, type FormEvent } from 'react';
import { ClipboardCheck, Loader2, RefreshCw } from 'lucide-react';
import { apiFetch } from '@cloud-client';
import { permits, type Role } from '../../shared/access.mjs';
import { fiveSActions, fiveSHistoryLimit, type FiveSAction, type FiveSRecords } from '../../shared/five-s.mjs';

const rackName = (rack: number) => `${String(rack).padStart(2, '0')} 号货架`;
const formatTime = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const rackStates = {
  unrecorded: { label: '未登记', tone: 'neutral' },
  complete: { label: '待检查', tone: 'amber' },
  pass: { label: '已通过', tone: 'green' },
  rework: { label: '待整改', tone: 'red' },
  correct: { label: '待复检', tone: 'amber' }
} as const;

export default function FiveSBoard({ racks, layoutRevision, operatorName, role, online }: {
  racks: number[];
  layoutRevision: number;
  operatorName: string;
  role: Role;
  online: boolean;
}) {
  const [requestedRack, setRequestedRack] = useState(racks[0]);
  const rack = racks.includes(requestedRack) ? requestedRack : racks[0];
  const [remote, setRemote] = useState<{ rack: number; records: FiveSRecords } | null>(null);
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [note, setNote] = useState('');
  const [inspection, setInspection] = useState<'' | 'pass' | 'rework'>('');

  useEffect(() => {
    if (rack === undefined || !online) return;
    const controller = new AbortController();
    setLoading(true);
    setLoadError('');
    async function loadRecords() {
      try {
        const response = await apiFetch('/api/five-s', { body: JSON.stringify({ rack, layoutRevision }) });
        const records = await response.json() as FiveSRecords & { error?: string };
        if (!response.ok) throw new Error(records.error || '暂时无法读取 5S 记录，请刷新重试。');
        if (!controller.signal.aborted) setRemote({ rack, records });
      } catch (error) {
        if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : '暂时无法读取 5S 记录。');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void loadRecords();
    return () => controller.abort();
  }, [rack, layoutRevision, online, reload]);

  const latest = new Map(remote?.records.latest.map(event => [event.rack, event]));
  const history = remote?.rack === rack ? remote.records.history : [];
  const current = history[0];
  if (current) latest.set(rack, current);
  const state = rackStates[latest.get(rack)?.action ?? 'unrecorded'];
  const inspecting = current?.action === 'complete' || current?.action === 'correct';
  const action: FiveSAction | '' = inspecting ? inspection : current?.action === 'rework' ? 'correct' : 'complete';
  const canAct = permits(role, inspecting ? 'inspectFiveS' : 'recordFiveS');
  const ready = online && rack !== undefined && !saving && remote?.rack === rack && !loading && !loadError;

  function selectRack(next: number) {
    if (next === rack) return;
    setRequestedRack(next);
    setNote('');
    setInspection('');
    setNotice(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || !canAct || !action || (action === 'rework' && !note.trim())) return;
    setSaving(true);
    setNotice(null);
    try {
      const response = await apiFetch('/api/five-s', {
        method: 'POST', body: JSON.stringify({
          id: crypto.randomUUID(), rack, layoutRevision, action, note: note.trim(),
          expectedId: current?.id ?? null
        })
      });
      if (!response.ok) {
        const body = await response.json() as { error?: string };
        throw new Error(body.error || '提交未完成，请核对记录后重试。');
      }
      setNotice({ text: `${rackName(rack)}已保存${fiveSActions[action].label}记录。` });
      setNote('');
      setInspection('');
    } catch (error) {
      const message = error instanceof Error && !(error instanceof TypeError)
        ? error.message : '提交结果待核对，请刷新记录。';
      setNotice({ text: message, error: true });
    } finally {
      setLoading(true);
      setReload(value => value + 1);
      setSaving(false);
    }
  }

  if (rack === undefined) return <section className="surface five-s-empty">当前布局暂无货架。</section>;

  return (
    <div className="five-s">
      <div className="five-s-grid">
        <section className="surface">
          <div className="section-top">
            <h2>选择货架</h2>
            <button className="secondary-button small" type="button" disabled={!online || saving || loading} onClick={() => setReload(value => value + 1)}>
              <RefreshCw size={15} />刷新记录
            </button>
          </div>
          <div className="five-s-racks">
            {racks.map(number => {
              const rackState = rackStates[latest.get(number)?.action ?? 'unrecorded'];
              return (
                <button type="button" key={number} aria-pressed={number === rack} disabled={saving} onClick={() => selectRack(number)}>
                  <b>{rackName(number)}</b>
                  {remote && <span className={`five-s-status ${rackState.tone}`}>{rackState.label}</span>}
                </button>
              );
            })}
          </div>
        </section>
        <section className="surface">
          <div className="section-top">
            <h2>{rackName(rack)}</h2>
            {remote && <span className={`five-s-status ${state.tone}`}>{state.label}</span>}
          </div>
          <div className="five-s-content">
            {loadError && <p className="five-s-message error" role="alert">{loadError}</p>}
            {!online && <p className="five-s-message error" role="alert">终端离线，恢复联网后可登记。</p>}
            {loading && online && <p className="five-s-message" role="status">正在读取记录…</p>}
            {notice && <p className={`five-s-message${notice.error ? ' error' : ''}`} role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}
            {current?.action === 'rework' && <p className="five-s-rework"><b>上次整改意见</b>{current.note}</p>}
            {remote?.rack === rack && !canAct && <p className="five-s-message">
              {inspecting ? '等待线长或管理员检查。' : '等待现场工人或管理员登记。'}
            </p>}
            {remote?.rack === rack && canAct && (
              <form className="five-s-form" onSubmit={submit}>
                <label>{inspecting ? '检查人' : '执行人'}<input type="text" value={operatorName} readOnly /></label>
                {inspecting && (
                  <fieldset disabled={!ready}>
                    <legend>检查结果</legend>
                    <label><input type="radio" name="inspection" value="pass" checked={inspection === 'pass'} onChange={() => setInspection('pass')} />通过</label>
                    <label><input type="radio" name="inspection" value="rework" checked={inspection === 'rework'} onChange={() => setInspection('rework')} />需整改</label>
                  </fieldset>
                )}
                <label>{action === 'rework' ? '整改意见（必填）' : inspecting ? '检查备注（选填）' : '执行备注（选填）'}
                  <textarea rows={3} maxLength={300} required={action === 'rework'} value={note} disabled={!ready} onChange={event => setNote(event.target.value)} />
                </label>
                <button className="primary-button" type="submit" disabled={!ready || !action || (action === 'rework' && !note.trim())}>
                  {saving ? <Loader2 size={17} className="spin" /> : <ClipboardCheck size={17} />}
                  {inspecting ? (current?.action === 'correct' ? '保存复检结果' : '保存检查结果') :
                    action === 'correct' ? '提交整改完成' : current?.action === 'pass' ? '登记新一轮完成' : '登记5S完成'}
                </button>
              </form>
            )}
          </div>
        </section>
      </div>
      <section className="surface">
        <div className="section-top"><h2>{rackName(rack)}记录</h2><small>最近 {fiveSHistoryLimit} 条</small></div>
        {history.length ? (
          <div className="table-scroll">
            <table>
              <thead><tr><th>登记时间</th><th>操作</th><th>登记人</th><th>备注</th></tr></thead>
              <tbody>{history.map(event => (
                <tr key={event.id}><td>{formatTime(event.recorded_at)}</td><td>{fiveSActions[event.action].label}</td><td>{event.operator}</td><td className="five-s-note">{event.note || '—'}</td></tr>
              ))}</tbody>
            </table>
          </div>
        ) : <p className="five-s-empty">{loading ? '正在读取记录…' : loadError ? '请刷新后查看记录。' : '该货架暂无记录。'}</p>}
      </section>
    </div>
  );
}
