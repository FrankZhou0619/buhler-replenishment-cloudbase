import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Camera, RefreshCw, ShieldCheck, UserPlus } from 'lucide-react';
import { apiFetch, faceGateway, faceLoginAvailable } from '@cloud-client';
import { roleLabels, type Role } from '../../shared/access.mjs';
import type { Actor } from '../lib/bootstrap';
import FaceCapture from './face-capture';

type FaceStatus = 'off' | 'ready' | 'bound';
type MemberForm = { uid: string; username: string; label: string; role: Role; enabled: boolean };
type Member = MemberForm & { faceStatus: FaceStatus; enrolledAt: string; protected: boolean };
type Directory = { revision: number; faceConfigured: boolean; members: Member[]; changes: { actorUid: string; uid: string; previousUid?: string; action: string; at: string }[] };
type Profile = {
  uid: string; username: string; label: string; status: FaceStatus; enrolledAt: string;
  canEnroll: boolean; faceConfigured: boolean; notice: string; noticeVersion: string; noticeChanged: boolean;
};

const faceLabels: Record<FaceStatus, string> = { off: '未开通', ready: '待本人录入', bound: '已绑定' };
const newMember: MemberForm = { uid: '', username: '', label: '', role: 'worker', enabled: true };
const date = (value: string) => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '—';
const groupOptions = Object.entries(roleLabels) as [Role, string][];
const failure = (value: unknown) => value instanceof Error ? value.message : '操作未完成，请重试。';

async function accessApi<T>(path: string, body?: object): Promise<T> {
  const response = await apiFetch(path, body ? { method: 'POST', body: JSON.stringify(body) } : undefined);
  const result = await response.json();
  if (!response.ok) throw new Error(result?.error || '操作未完成，请重试。');
  return result;
}

export function AccessSettings() {
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [form, setForm] = useState<MemberForm>(newMember);
  const [editTarget, setEditTarget] = useState<{ uid: string; revision: number } | null>(null);
  const [removing, setRemoving] = useState<Member | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const editForm = useRef<HTMLFormElement>(null);
  const uidField = useRef<HTMLInputElement>(null);
  const usernameField = useRef<HTMLInputElement>(null);
  const removeDialog = useRef<HTMLDialogElement>(null);
  const editing = directory?.members.find(member => member.uid === editTarget?.uid);
  const uidChanged = editTarget !== null && editTarget.uid !== form.uid.trim();

  async function refresh() {
    const updated = await accessApi<Directory>('/api/access');
    setDirectory(updated);
    if (editTarget && editTarget.revision !== updated.revision) {
      edit(null);
      setNotice('人员名单已更新，请重新选择要编辑的人员。');
    }
  }

  useEffect(() => { void refresh().catch(e => setError(failure(e))); }, []);

  async function run(operation: () => Promise<void>) {
    setBusy(true);
    setNotice('');
    setError('');
    try { await operation(); } catch (e) { setError(failure(e)); }
    finally { setBusy(false); }
  }

  function edit(member: Member | null) {
    setEditTarget(member && directory ? { uid: member.uid, revision: directory.revision } : null);
    setForm(member ? { uid: member.uid, label: member.label, username: member.username, role: member.role, enabled: member.enabled } : newMember);
  }

  function startEdit(member: Member) {
    setError('');
    setNotice('');
    edit(member);
    editForm.current?.scrollIntoView({ block: 'nearest' });
    (member.protected ? usernameField : uidField).current?.focus({ preventScroll: true });
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !directory) return;
    await run(async () => {
      const updated = await accessApi<Directory>('/api/access/member/save', {
        ...form, originalUid: editTarget?.uid ?? null, revision: editTarget?.revision ?? directory.revision
      });
      setDirectory(updated);
      edit(null);
      setNotice(uidChanged ? 'UID 已更正。' : '人员权限已保存。');
    });
  }

  async function remove(event: FormEvent) {
    event.preventDefault();
    if (busy || !directory || !removing) return;
    await run(async () => {
      const updated = await accessApi<Directory>('/api/access/member/remove', { uid: removing.uid, revision: directory.revision });
      setDirectory(updated);
      if (editTarget?.uid === removing.uid) edit(null);
      else if (editTarget?.revision === directory.revision) setEditTarget({ ...editTarget, revision: updated.revision });
      setNotice(`已删除 ${removing.label} 的人员记录。`);
      removeDialog.current?.close();
    });
  }

  function changeFace(member: Member, action: 'allow' | 'reset' | 'disable') {
    if (!directory) return;
    void run(async () => {
      await accessApi('/api/access/face', { uid: member.uid, action, revision: directory.revision });
      await refresh();
      setNotice(action === 'disable' ? '已停用刷脸并移除参考图。' : '已开放录入，请员工用账号密码登录后操作。');
    });
  }

  return <div className="access-settings">
    <section className="surface">
      <div className="section-top"><h2><ShieldCheck size={18} />权限组成员</h2>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => run(refresh)}><RefreshCw size={14} />刷新</button>
      </div>
      {error && <p className="access-message login-error" role="alert">{error}</p>}
      {notice && <p className="access-message" role="status">{notice}</p>}
      {directory && <div className="table-scroll"><table>
        <thead><tr><th>姓名与账号</th><th>CloudBase 用户 UID</th><th>权限组</th><th>账号状态</th><th>人脸登录</th><th>操作</th></tr></thead>
        <tbody>{directory.members.map(member => <tr key={member.uid}>
          <td><b>{member.label}</b>{member.username && <div className="access-muted">{member.username}</div>}</td>
          <td><code>{member.uid}</code></td>
          <td>{roleLabels[member.role]}</td>
          <td>{member.enabled ? '启用' : '停用'}</td>
          <td><span>{faceLabels[member.faceStatus]}</span>{member.enrolledAt && <div className="access-muted">{date(member.enrolledAt)}</div>}</td>
          <td><div className="access-row-actions">
            <button type="button" className="text-button" disabled={busy} aria-label={`编辑人员 ${member.label}`} onClick={() => startEdit(member)}>编辑人员</button>
            {directory.faceConfigured && member.enabled && member.username && member.faceStatus === 'off' &&
              <button type="button" className="text-button" disabled={busy} onClick={() => changeFace(member, 'allow')}>开放录入</button>}
            {directory.faceConfigured && member.faceStatus === 'bound' &&
              <button type="button" className="text-button" disabled={busy} onClick={() => changeFace(member, 'reset')}>重置并允许重录</button>}
            {member.faceStatus !== 'off' &&
              <button type="button" className="text-button" disabled={busy} onClick={() => changeFace(member, 'disable')}>停用并移除人脸</button>}
            {member.protected ? <span className="access-muted">后台配置</span> :
              <button type="button" className="text-button access-danger" disabled={busy}
                aria-label={`删除人员 ${member.label}`} onClick={() => {
                  setError('');
                  setNotice('');
                  setRemoving(member);
                  removeDialog.current?.showModal();
                }}>删除人员</button>}
          </div></td>
        </tr>)}</tbody>
      </table></div>}
    </section>
    <section className="surface">
      <div className="section-top"><h2><UserPlus size={18} />{editTarget ? `编辑人员${editing ? ' · ' + editing.label : ''}` : '添加已开通的人员'}</h2></div>
      <form ref={editForm} className="access-form" onSubmit={save}>
        <p className="access-muted">先在 CloudBase 用户管理中创建账号，再把完整 UID 和登录用户名填到这里。</p>
        <div className="access-fields">
          <label>CloudBase 用户 UID<input ref={uidField} required value={form.uid} readOnly={editing?.protected} disabled={busy} maxLength={128}
            autoComplete="off" spellCheck={false}
            onChange={e => setForm({ ...form, uid: e.target.value })} /></label>
          <label>登录用户名<input ref={usernameField} required value={form.username} disabled={busy} maxLength={128}
            onChange={e => setForm({ ...form, username: e.target.value })} /></label>
          <label>员工姓名<input required value={form.label} disabled={busy} maxLength={60} onChange={e => setForm({ ...form, label: e.target.value })} /></label>
          <label>权限组<select value={form.role} disabled={busy || editing?.protected} onChange={e => setForm({ ...form, role: e.target.value as Role })}>
            {groupOptions.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select></label>
        </div>
        <label className="access-check"><input type="checkbox" checked={form.enabled} disabled={busy || editing?.protected}
          onChange={e => setForm({ ...form, enabled: e.target.checked })} />启用该人员的看板权限</label>
        {editing?.protected && <p className="access-muted">基础管理员的 UID 和权限由云函数配置管理。</p>}
        {uidChanged && <p className="access-warning">保存后，权限将关联到新 UID，原 UID 的人脸绑定会清除。请核对新 UID 对应的 CloudBase 账号。</p>}
        <div className="face-actions"><button className="primary-button" disabled={busy || !directory} type="submit">保存权限</button>
          {editTarget && <button type="button" className="secondary-button" disabled={busy} onClick={() => edit(null)}>取消编辑</button>}
        </div>
      </form>
    </section>
    {directory && directory.changes.length > 0 && <section className="surface">
      <div className="section-top"><h2>权限变更记录</h2></div>
      <div className="table-scroll"><table><thead><tr><th>时间</th><th>操作人 UID</th><th>成员 UID</th><th>操作</th></tr></thead>
        <tbody>{directory.changes.map((change, index) => <tr key={change.at + index}>
          <td>{date(change.at)}</td><td>{change.actorUid}</td>
          <td>{change.previousUid && <><code>{change.previousUid}</code> → </>}<code>{change.uid}</code></td><td>{change.action}</td>
        </tr>)}</tbody></table></div>
    </section>}
    <dialog ref={removeDialog} className="access-confirm" aria-labelledby="access-remove-title"
      onClose={() => setRemoving(null)} onCancel={event => { if (busy) event.preventDefault(); }}>
      {removing && <form onSubmit={remove}>
        <h2 id="access-remove-title">删除人员</h2>
        <p>删除 <strong>{removing.label}</strong>（{removing.username ? `${removing.username}，` : ''}UID <code>{removing.uid}</code>）的看板权限和人脸绑定。已有业务记录会保留。</p>
        {error && <p className="login-error" role="alert">{error}</p>}
        <div className="face-actions">
          <button type="button" className="secondary-button" disabled={busy} autoFocus onClick={() => removeDialog.current?.close()}>取消</button>
          <button type="submit" className="primary-button access-danger-button" disabled={busy}>{busy ? '正在删除…' : '确认删除'}</button>
        </div>
      </form>}
    </dialog>
  </div>;
}

export function FaceProfile({ actor, onLogout }: { actor: Actor; onLogout: () => void }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [withdrawing, setWithdrawing] = useState(false);
  async function reload() { setProfile(await accessApi<Profile>('/api/face/profile')); }
  useEffect(() => { void reload().catch(e => setError(failure(e))); }, []);

  async function withdraw() {
    setWithdrawing(true); setError('');
    try {
      await accessApi('/api/face/withdraw', {});
      if (actor.authMethod === 'face') { onLogout(); return; }
      setConsent(false);
      await reload();
      setNotice('已撤回刷脸授权并移除参考图。');
    } catch (e) { setError(failure(e)); }
    finally { setWithdrawing(false); }
  }

  return <section className="surface">
    <div className="section-top"><h2><Camera size={18} />我的登录方式</h2></div>
    <div className="access-form face-profile">
      {error && <p className="login-error" role="alert">{error}</p>}
      {notice && <p className="access-message" role="status">{notice}</p>}
      {profile && <>
        <dl className="face-profile-summary">
          <div><dt>本人账号</dt><dd>{profile.label} · {profile.username || profile.uid}</dd></div>
          <div><dt>权限组</dt><dd>{roleLabels[actor.role]}</dd></div>
          <div><dt>人脸绑定</dt><dd>{faceLabels[profile.status]} {profile.enrolledAt && date(profile.enrolledAt)}</dd></div>
        </dl>
        {profile.canEnroll && faceLoginAvailable() && <>
          <div className="face-notice"><b>人脸信息处理说明</b><p>{profile.notice}</p></div>
          <label className="access-check"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />
            我已阅读说明，并单独同意按上述方式处理本人的人脸信息。</label>
          {consent && <FaceCapture enrollment start={async signal => {
            const { grant } = await accessApi<{ grant: string }>('/api/face/enroll', { consent, noticeVersion: profile.noticeVersion });
            return faceGateway({ action: 'beginEnrollment', grant }, signal);
          }} complete={async result => {
            if (!result.enrolled) throw new Error('人脸未绑定，请重试。');
            await reload();
            setConsent(false);
            setNotice('人脸已绑定，可以退出后用刷脸登录验证。');
          }} />}
        </>}
        {profile.status === 'off' && <p className="access-muted">请联系管理员开放录入。你可以继续使用账号密码登录。</p>}
        {profile.status === 'ready' && (!profile.faceConfigured || !faceLoginAvailable()) &&
          <p className="access-muted">人脸核验入口尚未配置。请联系管理员。</p>}
        {profile.noticeChanged && <p className="access-muted">人脸信息处理说明有更新。请联系管理员重置后重新确认并录入。</p>}
        {profile.status === 'bound' && <button type="button" className="secondary-button" disabled={withdrawing} onClick={withdraw}>撤回授权并移除人脸</button>}
      </>}
    </div>
  </section>;
}
