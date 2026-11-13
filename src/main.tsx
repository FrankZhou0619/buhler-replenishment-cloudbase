import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LockKeyhole, ScanFace, Warehouse } from 'lucide-react';
import { initialize, signIn, signOut, apiFetch, faceGateway, faceLoginAvailable, signInWithFaceTicket } from '@cloud-client';
import type { Actor } from './lib/bootstrap';
import type { BoardConfig } from './lib/model';
import Home from './Home';
import FaceCapture from './components/face-capture';
import './styles.css';
import './arims.css';
import './layout.css';
import './access.css';
import './five-s.css';
import './customer-demo.css';

function App() {
  const [session, setSession] = useState<(BoardConfig & { actor: Actor }) | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [configured, setConfigured] = useState(false), [username, setUsername] = useState(''), [password, setPassword] = useState('');
  const [method, setMethod] = useState<'password' | 'face'>('password');
  async function bootstrap() {
    const response = await apiFetch('/api/bootstrap'), data = await response.json();
    if (!response.ok) throw new Error(data.error || '账号尚未开通。');
    setSession({ layoutRevision: 0, layoutSource: 'Bühler Wuxi 物料主表', ...data });
    setPassword('');
  }
  useEffect(() => {
    let active = true;
    initialize().then(async loggedIn => { if (!active) return; setConfigured(true); if (loggedIn) await bootstrap(); }).catch(e => { if (active) setError(e.message || '连接未完成。'); }).finally(() => { if (active) setLoading(false); });
    const expired = () => { setSession(null); setPassword(''); setError('登录已过期，请重新登录。'); };
    window.addEventListener('cloudbase-session-expired', expired);
    return () => { active = false; window.removeEventListener('cloudbase-session-expired', expired); };
  }, []);
  async function login(e: React.FormEvent) {
    e.preventDefault(); setLoading(true); setError('');
    try { await signIn(username, password); await bootstrap(); } catch (e) { setError(e instanceof Error ? e.message : '登录未完成。'); } finally { setPassword(''); setLoading(false); }
  }
  async function logout() {
    try { await signOut(); setSession(null); setError(''); setPassword(''); setMethod('password'); } catch (e) { alert(e instanceof Error ? e.message : '退出未完成。'); }
  }
  if (session) return <Home actor={session.actor} initialBoard={session} onLogout={logout} />;
  const selectMethod = (value: 'password' | 'face') => { setMethod(value); setError(''); setPassword(''); };
  const accountInput = <label>账号<input aria-label="登录账号" name="username" autoComplete="username" value={username}
    onChange={e => setUsername(e.target.value)} disabled={loading} required maxLength={128} /></label>;
  return <div className="login-shell">
    <section className="login-intro"><span className="login-brand">BOSSARD</span><div><span className="eyebrow">Bühler Wuxi</span><h1>线边仓电子补料</h1><p>现场巡检、缺料汇总与补料确认，<br />在同一块看板上完成。</p><div className="login-feature"><Warehouse size={24} /><span>按现场货架位置操作<br /><small>让每一次补料都有记录</small></span></div></div><small>Proven Productivity</small></section>
    <section className="login-card">
      <div className="login-lock">{method === 'face' ? <ScanFace size={25} /> : <LockKeyhole size={25} />}</div>
      <h2>登录工作看板</h2><p>请使用管理员为你开通的账号</p>
      <div className="login-methods" aria-label="登录方式">
        <button type="button" aria-pressed={method === 'password'} disabled={loading} onClick={() => selectMethod('password')}>账号密码</button>
        <button type="button" aria-pressed={method === 'face'} disabled={loading} onClick={() => selectMethod('face')}><ScanFace size={15} />人脸识别登录</button>
      </div>
      {error && <div className="login-error" role="alert">{error}</div>}
      {method === 'password' ? <form onSubmit={login}>{accountInput}
        <label>密码<input aria-label="登录密码" name="password" type="password" autoComplete="current-password" value={password}
          onChange={e => setPassword(e.target.value)} required maxLength={256} /></label>
        <button className="primary-button" disabled={loading || !configured} type="submit">{loading ? '正在连接…' : '登录'}</button>
      </form> : <div className="login-face-form">
        {accountInput}
        {faceLoginAvailable() ? <>
          <p className="access-muted">适用于已绑定人脸的账号。核验时会将当次短视频提交给腾讯云活体比对。</p>
          <FaceCapture key={username.trim()} enabled={configured && !loading && !!username.trim()}
            start={signal => faceGateway({ action: 'beginLogin', username: username.trim() }, signal)}
            complete={async ({ ticket }) => {
              if (!ticket) throw new Error('核验服务未返回登录凭证。');
              setLoading(true);
              try { await signInWithFaceTicket(ticket); await bootstrap(); }
              finally { setLoading(false); }
            }} />
        </> : <p className="login-error">人脸核验入口尚未配置，请使用账号密码登录。</p>}
      </div>}
    </section>
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);
