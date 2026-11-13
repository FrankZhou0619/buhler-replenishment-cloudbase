// Used only by scripts/preview.mjs. Never included in the production build.
export async function initialize() { return false; }
export async function signIn(username: string, password: string) {
  if (username !== 'demo-admin' || password !== 'preview-password') throw new Error('本地测试账号不正确。');
}
export async function signOut() {}
export const faceLoginAvailable = () => true;
export async function faceGateway<T>(_input: object, _signal: AbortSignal): Promise<T> {
  throw new Error('本地界面预览使用样例账号。请在已配置的 CloudBase 环境测试真实核验。');
}
export async function signInWithFaceTicket(_ticket: string) {
  throw new Error('本地界面预览使用账号密码。');
}
export async function apiFetch(path: string, options: RequestInit = {}) {
  return fetch('/preview-api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, method: options.method || 'GET', body: options.body ? JSON.parse(String(options.body)) : {} }) }).then(async response => { const result = await response.json(); if (result.status === 401) window.dispatchEvent(new Event('cloudbase-session-expired')); return new Response(JSON.stringify(result.data), { status: result.status, headers: { 'Content-Type': 'application/json' } }); });
}
