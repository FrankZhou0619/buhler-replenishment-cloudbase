'use client';
import { apiFetch } from '@cloud-client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowRight, Check, CheckCircle2, ChevronLeft, ChevronRight, Code2, FileCode2, FileSpreadsheet, FlaskConical, KeyRound, Loader2, LogOut, Search, ShieldCheck, Trash2, Upload, Wifi, XCircle } from 'lucide-react';
import { ARIMS_SAMPLE_XML, arimsCsv, parseArimsXml, type ArimsResult, type ArimsRow } from '@/lib/arims-data';

type Action = 'login' | 'stocklist' | 'logout';
type Entry = Omit<ArimsResult, 'token'> & { id: number; action: Action; at: string; proxyStatus: number; truncated?: boolean };
const actions = { login: '登录认证', stocklist: '查询库存', logout: '注销会话' };
const columns = [['physicalAddress', '实体库位'], ['customerItemNumber', '客户物料号'], ['description', '物料描述'], ['dimension', '规格'], ['stockAmount', '库存数量'], ['reorderQuantity', '补料数量'], ['unit', '单位'], ['siteName', '站点']] as const;
const baseUrl = 'https://arims.bossard.com/arims/rest_stockinfo/v1';
function download(name: string, text: string, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const clock = (at: string) => new Date(at).toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });

export default function ArimsDebugger() {
  const [username, setUsername] = useState(''), [password, setPassword] = useState(''), [customerId, setCustomerId] = useState('');
  const [authenticated, setAuthenticated] = useState(false), [permissions, setPermissions] = useState<string[]>([]);
  const [busy, setBusy] = useState<Action | null>(null), [error, setError] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]), [tab, setTab] = useState<'response' | 'request' | 'headers' | 'log'>('response');
  const [xml, setXml] = useState(''), [source, setSource] = useState<'none' | 'api' | 'sample' | 'file'>('none');
  const [search, setSearch] = useState(''), [page, setPage] = useState(0), [pageSize, setPageSize] = useState(20), [selected, setSelected] = useState<ArimsRow | null>(null);
  const token = useRef(''), inFlight = useRef(false), abort = useRef<AbortController | null>(null), fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => () => { abort.current?.abort(); token.current = ''; }, []);
  const parsed = useMemo(() => {
    if (!xml) return { rows: [] as ArimsRow[], root: '', error: '' };
    try { return { ...parseArimsXml(xml), error: '' }; }
    catch (e) { return { rows: [] as ArimsRow[], root: '', error: e instanceof Error ? e.message : 'XML 解析失败。' }; }
  }, [xml]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? parsed.rows.filter(row => Object.values(row).some(value => value.toLowerCase().includes(q))) : parsed.rows;
  }, [search, parsed.rows]);
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize)), currentPage = Math.min(page, pages - 1);
  const visibleRows = filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const latest = entries[0];
  const status = busy ? '请求中' : latest ? latest.upstreamStatus ? `ARIMS HTTP ${latest.upstreamStatus}` : `后台 HTTP ${latest.proxyStatus}` : '等待请求';
  const sessionState = authenticated ? '会话已就绪' : '尚未登录';
  const setData = (text: string, origin: typeof source) => { setXml(text); setSource(origin); setSearch(''); setPage(0); setSelected(null); };
  const clearSession = () => { token.current = ''; setAuthenticated(false); setPermissions([]); };
  const run = async (action: Action) => {
    if (inFlight.current) return;
    if (action === 'login' && (!username.trim() || !password)) { setError('请先填写 ARIMS 用户名和密码。'); return; }
    if (action !== 'login' && !token.current) { setError('请先登录，获取有效的 ARIMS 会话。'); return; }
    if (action === 'stocklist' && !/^[A-Za-z0-9_-]{1,80}$/.test(customerId.trim())) { setError('请填写真实客户编号，支持字母、数字、短横线和下划线。'); return; }
    inFlight.current = true; setBusy(action); setError(''); setTab('response');
    if (action === 'login') { clearSession(); setEntries([]); setData('', 'none'); }
    if (action === 'stocklist') setData('', 'none');
    const started = Date.now(), at = new Date().toISOString();
    const controller = new AbortController(); abort.current = controller;
    const timeout = setTimeout(() => controller.abort(new Error('ARIMS request timed out')), 26_000);
    const cancelled = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    });
    let proxyStatus = 0;
    try {
      const requestBody = action === 'login' ? { action, username: username.trim(), password } : { action, token: token.current, ...(action === 'stocklist' ? { customerId: customerId.trim() } : {}) };
      const response = await Promise.race([
        apiFetch('/api/arims', { method: 'POST', body: JSON.stringify(requestBody) }),
        cancelled,
      ]);
      proxyStatus = response.status;
      const text = await response.text();
      let result: ArimsResult;
      try {
        const data = JSON.parse(text);
        result = typeof data?.ok === 'boolean'
          ? data
          : { ok: false, error: data?.error, code: data?.code };
        if (!response.ok && !result.error) throw new Error();
        if (response.ok && typeof data?.ok !== 'boolean') throw new Error();
      }
      catch { throw new Error(`网页后台未返回有效的调试结果（HTTP ${response.status}），请刷新页面后重试。`); }
      if (action === 'login' && result.ok) {
        if (!result.token) throw new Error('网页后台未返回可用的 ARIMS 会话，请查看响应。');
        token.current = result.token; setAuthenticated(true); setPermissions(result.permissions || []);
      }
      if ((action === 'logout' && result.ok) || result.upstreamStatus === 401) clearSession();
      if (action === 'stocklist' && result.ok) setData(result.responseBody || '', 'api');
      const safe = { ...result }; delete safe.token;
      const body = safe.responseBody || '';
      const entry: Entry = { ...safe, responseBody: body.slice(0, 30_000), truncated: body.length > 30_000, id: started, action, at, proxyStatus };
      setEntries(old => [entry, ...old].slice(0, 10));
      if (!result.ok) setError(result.error || '请求未完成，请查看响应详情。');
    } catch (e) {
      const message = controller.signal.aborted ? '网页端等待超时，未获得完整结果。请检查网络或稍后重试。' : e instanceof Error && (e.message.startsWith('网页后台') || e.message.startsWith('云函数')) ? e.message : '网页未能获得后台响应，请检查网络连接后重试。';
      setError(message);
      setEntries(old => [{ ok: false, error: message, code: 'BROWSER_CONNECTION', elapsedMs: Date.now() - started, id: started, action, at, proxyStatus }, ...old].slice(0, 10));
    } finally {
      if (action === 'login') setPassword('');
      clearTimeout(timeout); inFlight.current = false; abort.current = null; setBusy(null);
    }
  };
  const importXml = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { setError('本地 XML 文件请控制在 8 MB 以内。'); return; }
    try { setData(await file.text(), 'file'); setError(''); setTab('response'); }
    catch { setError('无法读取本地 XML 文件。'); }
  };
  const sample = () => { setData(ARIMS_SAMPLE_XML, 'sample'); setTab('response'); setError(''); };
  const reset = () => { clearSession(); setPassword(''); setUsername(''); setCustomerId(''); setEntries([]); setData('', 'none'); setError(''); setTab('response'); };
  const showXml = Boolean(xml && (source !== 'api' || latest?.action === 'stocklist'));
  const responseText = (showXml ? xml : '') || latest?.responseBody || latest?.error || '';
  const sourceLabel = source === 'sample' ? '示例数据 · 未连接 ARIMS' : source === 'file' ? '本地 XML · 非在线查询' : source === 'api' ? 'ARIMS 实际响应' : '尚无库存数据';

  return <div className="arims-debugger">
    <div className="arims-intro"><div className="arims-intro-icon"><Code2 size={22} /></div><div><b>ARIMS Stock List Web API</b><p>登录获取会话，按客户编号查询库存。体验版请求较慢时，可导入本地 XML 检查数据。</p></div><span className="arims-protocol">REST / XML</span></div>
    <div className="arims-grid">
      <section className="surface arims-connect"><div className="section-top"><h2><KeyRound size={18} />连接与认证</h2><span className={`pill ${authenticated ? 'green' : 'neutral'}`}><i />{sessionState}</span></div>
        <div className="arims-form">
          <form onSubmit={e => { e.preventDefault(); void run('login'); }} autoComplete="off">
            <div className="arims-step"><span>01</span><b>登录 ARIMS</b><small>POST /auth/login</small></div>
            <label htmlFor="arims-user">用户名<input id="arims-user" name="arims-user" value={username} onChange={e => setUsername(e.target.value)} disabled={!!busy} maxLength={200} placeholder="有库存清单权限的账号" autoComplete="off" /></label>
            <label htmlFor="arims-password">密码<input id="arims-password" name="arims-password" type="password" value={password} onChange={e => setPassword(e.target.value)} disabled={!!busy} maxLength={2048} placeholder="输入 ARIMS 密码" autoComplete="off" /></label>
            <button className="primary-button arims-wide" type="submit" disabled={!!busy || !username.trim() || !password}>{busy === 'login' ? <Loader2 size={16} className="spin" /> : <KeyRound size={16} />}登录并获取会话<ArrowRight size={15} /></button>
          </form>
          <form onSubmit={e => { e.preventDefault(); void run('stocklist'); }}>
            <div className="arims-step"><span>02</span><b>读取客户库存</b><small>GET /stocklist/…</small></div>
            <label htmlFor="arims-customer">客户编号 customerID<input id="arims-customer" value={customerId} onChange={e => setCustomerId(e.target.value)} disabled={!!busy} maxLength={80} placeholder="填写真实客户编号" autoComplete="off" /></label>
            <button className="primary-button arims-wide" type="submit" disabled={!!busy || !authenticated || !customerId.trim()}>{busy === 'stocklist' ? <Loader2 size={16} className="spin" /> : <Search size={16} />}查询库存清单</button>
          </form>
          <div className="arims-session-actions"><button className="secondary-button" disabled={!!busy || !authenticated} onClick={() => void run('logout')}>{busy === 'logout' ? <Loader2 size={15} className="spin" /> : <LogOut size={15} />}注销会话</button><button className="icon-button" disabled={!!busy} onClick={reset} title="清空本页输入和结果" aria-label="清空本页输入和结果"><Trash2 size={17} /></button></div>
          <div className="arims-privacy"><ShieldCheck size={16} /><p>凭据仅在本页临时使用。密码在登录请求后清空，刷新页面需重新登录。</p></div>
          {permissions.length > 0 && <details className="arims-permissions"><summary>查看账号权限（{permissions.length}）</summary><div>{permissions.map(p => <code key={p}>{p}</code>)}</div></details>}
        </div>
      </section>
      <section className="surface arims-response">
        <div className="section-top"><div><h2><Wifi size={18} />请求与响应</h2><p>HTTP 状态来自 ARIMS，连接与解析错误分别展示。</p></div><span className={`arims-state ${busy ? 'working' : latest ? latest.ok ? 'success' : 'failure' : ''}`} role="status">{busy ? <Loader2 size={14} className="spin" /> : latest ? latest.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} /> : <span className="arims-idle-dot" />}{status}</span></div>
        <div className="arims-metrics"><div><small>本次操作</small><b>{busy ? actions[busy] : latest ? actions[latest.action] : '尚未发送'}</b></div><div><small>后台请求耗时</small><b>{latest?.elapsedMs !== undefined ? `${latest.elapsedMs.toLocaleString()} ms` : '—'}</b></div><div><small>响应大小</small><b>{latest?.sizeBytes !== undefined ? `${(latest.sizeBytes / 1024).toFixed(1)} KB` : '—'}</b></div><div><small>最近请求 · UTC+8</small><b>{latest ? clock(latest.at) : '—'}</b></div></div>
        {error && <div className="arims-error" role="alert"><XCircle size={16} /><div><b>{error}</b>{latest?.code && <code>{latest.code}</code>}</div></div>}
        <div className="arims-result-tabs" role="tablist" aria-label="接口调试详情">{([['response', '响应正文'], ['request', '请求详情'], ['headers', '响应头'], ['log', `请求记录 ${entries.length}`]] as const).map(([id, label]) => <button type="button" role="tab" aria-selected={tab === id} key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>)}</div>
        <div className="arims-result-body" role="tabpanel" aria-label="接口响应详情">
          {tab === 'response' && (responseText ? <><div className="arims-code-caption"><span>{showXml ? sourceLabel : latest?.upstreamHeaders?.['content-type'] || '响应详情'}</span>{(responseText.length > 100_000 || (!xml && latest?.truncated)) && <span>预览已截取</span>}</div><pre className="arims-code">{responseText.slice(0, 100_000)}</pre></> : <div className="arims-response-empty"><FileCode2 size={35} /><h3>等待第一次响应</h3><p>填写账号并登录，再按客户编号查询。<br />也可载入示例或本地 XML，先查看解析效果。</p></div>)}
          {tab === 'request' && <div className="arims-request-info"><span className="arims-method">{latest?.method || 'POST'}</span><code>{latest?.url || `${baseUrl}/auth/login`}</code><pre>{latest?.requestSummary || 'Body: x-www-form-urlencoded\nuser=[用户名]\npassword=[密码]'}</pre><small>调试记录隐藏密码与 Token；只转发到文档指定的 ARIMS 地址。</small></div>}
          {tab === 'headers' && <pre className="arims-code">{latest?.upstreamHeaders && Object.keys(latest.upstreamHeaders).length ? Object.entries(latest.upstreamHeaders).map(([k, v]) => `${k}: ${v}`).join('\n') : '暂无 ARIMS 响应头。'}</pre>}
          {tab === 'log' && <div className="arims-log">{entries.length ? entries.map(entry => <details key={entry.id}><summary><span>{entry.ok ? <CheckCircle2 size={15} /> : <XCircle size={15} />}{actions[entry.action]}</span><code>{entry.upstreamStatus ? `ARIMS ${entry.upstreamStatus}` : `后台 ${entry.proxyStatus || '未连接'}`}</code><small>{clock(entry.at)} · {entry.elapsedMs || 0} ms</small></summary><code className="arims-log-url">{entry.method} {entry.url}</code>{entry.error && <p>{entry.error}</p>}<pre>{entry.responseBody || entry.code || ''}{entry.truncated ? '\n…记录预览已截取' : ''}</pre></details>) : <div className="arims-text-empty">本页还没有请求记录。</div>}</div>}
        </div>
      </section>
    </div>
    <section className="surface arims-stock"><div className="section-top"><div><h2><FileSpreadsheet size={18} />库存数据预览 <span className="count-chip">{parsed.rows.length}</span></h2><p>{sourceLabel}{parsed.root ? ` · XML 根节点 ${parsed.root}` : ''}</p></div><div className="arims-file-actions"><button className="secondary-button" disabled={!!busy} onClick={sample}><FlaskConical size={15} />载入示例</button><button className="secondary-button" disabled={!!busy} onClick={() => fileInput.current?.click()}><Upload size={15} />本地 XML</button><input ref={fileInput} type="file" accept=".xml,application/xml,text/xml" hidden onChange={e => { void importXml(e.target.files?.[0]); e.target.value = ''; }} /><button className="secondary-button" disabled={!xml || !!busy} onClick={() => download(`ARIMS-response.${parsed.error ? 'txt' : 'xml'}`, xml, parsed.error ? 'text/plain;charset=utf-8' : 'application/xml;charset=utf-8')}><ArrowDownToLine size={15} />原始响应</button><button className="secondary-button" disabled={!filtered.length || !!busy} onClick={() => download('ARIMS-stocklist.csv', arimsCsv(filtered), 'text/csv;charset=utf-8')}><ArrowDownToLine size={15} />导出 CSV</button></div></div>
      {source === 'sample' && <div className="arims-sample-notice"><FlaskConical size={15} />当前为虚构示例，仅用于演练界面与 XML 解析，未调用 ARIMS。</div>}
      {parsed.error && <div className="arims-error" role="alert"><XCircle size={16} />{parsed.error}</div>}
      {!!xml && !parsed.error && !parsed.rows.length && <div className="arims-sample-notice">XML 格式有效，但未识别到文档中的物料字段。请查看原始响应，确认是否为空清单或 XML 结构已有变化。</div>}
      <div className="arims-stock-tools"><label><Search size={16} /><input value={search} onChange={e => { setSearch(e.target.value); setPage(0); }} placeholder="搜索物料号、描述、规格或库位…" aria-label="搜索 ARIMS 库存" /></label><span>匹配 {filtered.length} / {parsed.rows.length} 条</span></div>
      <div className="table-scroll arims-stock-table"><table><thead><tr>{columns.map(([key, label]) => <th key={key}>{label}<small>{key}</small></th>)}<th>更多字段</th></tr></thead><tbody>{visibleRows.map((row, index) => <tr key={`${currentPage}-${index}`}>{columns.map(([key]) => <td key={key} className={['physicalAddress', 'customerItemNumber'].includes(key) ? 'mono' : ''}>{row[key] || '—'}</td>)}<td><button className="text-button" onClick={() => setSelected(selected === row ? null : row)}>{selected === row ? '收起' : '查看详情'}</button></td></tr>)}</tbody></table>{!visibleRows.length && <div className="arims-text-empty">{search ? '没有匹配的物料。' : '查询库存或载入 XML 后，在这里核对物料与库位。'}</div>}</div>
      <div className="arims-pagination"><small>CSV 包含全部匹配记录及文档定义的 34 个字段。</small><label>每页<select value={pageSize} aria-label="ARIMS 每页条数" onChange={e => { setPageSize(Number(e.target.value)); setPage(0); }}><option value={20}>20</option><option value={50}>50</option><option value={100}>100</option></select></label><button className="icon-button" aria-label="ARIMS 上一页" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={16} /></button><span>{currentPage + 1} / {pages}</span><button className="icon-button" aria-label="ARIMS 下一页" disabled={currentPage >= pages - 1} onClick={() => setPage(currentPage + 1)}><ChevronRight size={16} /></button></div>
      {selected && <div className="arims-row-details"><h3>物料详细字段 <button className="text-button" onClick={() => setSelected(null)}>收起</button></h3><dl>{Object.entries(selected).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value || '—'}</dd></div>)}</dl></div>}
    </section>
    <div className="arims-bottom-note"><Check size={15} /><span>查询结果用于调试与导出。字段按上传文档识别，实际 XML 结构与数据以 ARIMS 返回为准。</span><small>接口文档：2024-04-25</small></div>
  </div>;
}
