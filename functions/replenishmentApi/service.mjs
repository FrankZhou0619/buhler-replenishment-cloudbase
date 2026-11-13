import { createHash, randomUUID } from 'node:crypto';
import { mailFailure } from './mail-errors.mjs';
import { invokeArims } from './arims.mjs';
import { compareLocation, LayoutError, MAX_LAYOUT_BYTES, MAX_LAYOUT_ITEMS, pendingConflicts, validateCatalog, validateLayout } from '../../shared/board-layout.mjs';
import { API_VERSION } from './version.mjs';
import { createAccess } from './access.mjs';
import { createFaceProtocol } from './face-protocol.mjs';
import { AppError, fail } from './app-error.mjs';
import { permits } from '../../shared/access.mjs';
import { fiveSActions, fiveSHistoryLimit } from '../../shared/five-s.mjs';

export { AppError } from './app-error.mjs';
const clone = value => structuredClone(value);
const date8 = value => new Date(new Date(value).getTime() + 8 * 3600000).toISOString().slice(0, 10);
const list = value => String(value || '').split(/[;,，；\s]+/).filter(Boolean);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const initialState = () => ({ bins: {}, settings: {}, events: [], orderIds: [], dailyCompleted: { date: '', count: 0 } });
const defaultBin = location => ({ location, status: 'full', revision: 0, marked_at: null, updated_at: '', updated_by: '', request_id: null });
const fiveSOverviewId = 'five-s-overview';
const fiveSRackId = rack => `five-s-rack-${rack}`;

export function recipients(value) {
  fail(typeof value !== 'string' || value.length > 1000, '收件邮箱格式无效。');
  const unique = new Map();
  for (const email of list(value)) if (!unique.has(email.toLowerCase())) unique.set(email.toLowerCase(), email);
  const addresses = [...unique.values()];
  fail(addresses.length > 10 || addresses.some(v => !/^[^\s@<>;,]+@[^\s@<>;,]+\.[^\s@<>;,]+$/.test(v)), '请输入有效邮箱；最多10个，用分号、逗号或换行分隔。');
  return addresses.join('; ');
}
function fromEmail(value) {
  fail(typeof value !== 'string' || value.length > 254, '发件邮箱格式无效。');
  const email = value.trim();
  fail(email && !/^[^\s@<>;,]+@[^\s@<>;,]+\.[^\s@<>;,]+$/.test(email), '请填写完整发件邮箱，不要包含显示名或尖括号。');
  return email;
}
function fromName(value) {
  fail(typeof value !== 'string' || value.length > 80 || /[\r\n\0]/.test(value), '发件显示名最多80字，不能换行。');
  return value.trim() || 'Bühler 补料看板';
}
const opId = value => { fail(typeof value !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(value), '操作编号无效。'); return value; };
const columns = ['L', 'M', 'N', 'BI', 'BX'];
const headings = ['客户物料号 (L)', '物料描述 (M)', '规格 (N)', '补料数量 (BI)', '料盒位置 (BX)'];
export function csv(items) {
  const cell = value => { const s = String(value ?? ''); return '"' + (/^[=+@\-\t\r]/.test(s) ? "'" + s : s).replaceAll('"', '""') + '"'; };
  return '\ufeff' + [headings, ...items.map(item => columns.map(k => item[k]))].map(row => row.map(cell).join(',')).join('\r\n');
}
function mailText(order) {
  return `Bühler Wuxi 线边仓补料清单\n单号：${order.id}\n创建时间：${order.created_at}\n巡检人员：${order.created_by}\n共 ${order.items.length} 个料盒需要补料。\n\n` + order.items.map(i => `库位 (BX)：${i.BX}\n客户物料号 (L)：${i.L}\n物料描述 (M)：${i.M}\n规格 (N)：${i.N}\n补料数量 (BI)：${i.BI}`).join('\n\n') + '\n\n补料数量取自原表BI，不是实时库存。请按库位补料并在终端确认补满。';
}
function publicOrder(order) {
  return { id: order.id, created_at: order.created_at, created_by: order.created_by, items: order.items, status: order.status, recipient: order.recipient, error: order.error, sent_at: order.sent_at, completed_count: order.completed_locations.length, deliveries: (order.deliveries || []).map(d => ({ recipient: d.recipient, status: d.status, error: d.error, sent_at: d.sent_at })) };
}

export function createService({ store, catalog, layout, referenceImage, config = {}, fetchImpl = fetch, clock = () => new Date().toISOString() }) {
  const defaultBoard = { catalog, layout, referenceImage, layoutRevision: 0, layoutSource: 'Bühler Wuxi 物料主表' };
  const boardForState = state => state.board ? { ...state.board, referenceImage: '' } : defaultBoard;
  const requireLayoutRevision = (board, revision) => {
    fail((revision ?? 0) !== board.layoutRevision, '货架布局已更新，请刷新看板后再操作。', 409);
  };
  const access = createAccess({ store, config, clock });
  const face = createFaceProtocol({ store, access, now: () => Date.parse(clock()) });
  const settings = state => ({ recipients: state.settings.recipients || '', mailFrom: state.settings.mailFrom ?? config.MAIL_FROM ?? '', mailFromName: state.settings.mailFromName ?? config.MAIL_FROM_NAME ?? 'Bühler 补料看板' });
  const current = async target => clone(await target.get('state', 'current') || initialState());
  const addEvent = (state, event) => { state.events = [event, ...state.events.filter(e => e.id !== event.id)].slice(0, 150); };
  const audit = (actor, now, id, action, location, detail) => ({ id, action, location, created_at: now, operator: actor.label, actor_uid: actor.uid, detail });
  const replay = (record, actor, fingerprint) => {
    if (!record) return null;
    fail(record.actor_uid !== actor.uid || record.fingerprint !== fingerprint, '此操作编号已经用于其他操作，请刷新后重试。', 409);
    return { ...record.result, replay: true };
  };
  function updateBin(state, bin, target, actor, now, id) {
    bin.status = target === 'pending' ? 'pending' : 'full';
    bin.revision++;
    bin.updated_at = now;
    bin.updated_by = actor.label;
    bin.reported_by_uid = target === 'pending' ? actor.uid : null;
    if (target === 'pending') bin.marked_at = now;
    if (target !== 'full') bin.request_id = null;
    state.bins[bin.location] = bin;
    addEvent(state, audit(actor, now, id, target, bin.location, bin.request_id || ''));
  }
  async function recordRefill(tx, state, requestId, locations, now) {
    const today = date8(now);
    const count = state.dailyCompleted.date === today ? state.dailyCompleted.count : 0;
    state.dailyCompleted = { date: today, count: count + locations.length };
    if (!requestId) return;
    const order = await tx.get('orders', requestId);
    if (!order) return;
    order.completed_locations = [...new Set([...order.completed_locations, ...locations])];
    await tx.set('orders', requestId, order);
  }
  function requireFiveSRack(board, rack, revision) {
    requireLayoutRevision(board, revision);
    fail(!Number.isSafeInteger(rack) || !board.layout.some(item => item.rack === rack), '请选择当前布局中的货架。');
  }
  async function readFiveS(b) {
    const board = boardForState(await current(store));
    requireFiveSRack(board, b.rack, b.layoutRevision);
    const [overview, record] = await Promise.all([
      store.get('state', fiveSOverviewId), store.get('state', fiveSRackId(b.rack))
    ]);
    return {
      latest: board.layout.map(({ rack }) => overview?.racks?.[rack]).filter(Boolean),
      history: (record?.history || []).map(({ actor_uid, ...event }) => event)
    };
  }
  async function recordFiveS(b, actor) {
    fail(typeof b.action !== 'string' || !Object.hasOwn(fiveSActions, b.action), '5S 操作无效。');
    const rule = fiveSActions[b.action];
    fail(!permits(actor.role, rule.permission), '此账号没有执行该 5S 操作的权限。', 403);
    const id = opId(b.id), expectedId = b.expectedId === null ? null : opId(b.expectedId);
    const note = typeof b.note === 'string' ? b.note.trim() : '';
    fail(note.length > 300 || note.includes('\0'), '备注最多 300 字，且不能包含无效字符。');
    fail(b.action === 'rework' && !note, '请填写整改意见。');
    const { rack, action, layoutRevision } = b;
    const fingerprint = digest({ scope: 'five-s', rack, action, layoutRevision, expectedId, note });
    return store.transaction(async tx => {
      const previous = replay(await tx.get('ops', id), actor, fingerprint);
      if (previous) return previous;
      requireFiveSRack(boardForState(await current(tx)), rack, layoutRevision);
      const rackId = fiveSRackId(rack);
      const history = (await tx.get('state', rackId))?.history || [];
      const latest = history[0];
      fail(expectedId !== (latest?.id ?? null) || !rule.previous.includes(latest?.action ?? null), '货架状态已更新，请刷新记录后重试。', 409);
      const overview = await tx.get('state', fiveSOverviewId) || { racks: {} };
      const recordedAt = clock();
      const event = { id, rack, action, note, operator: actor.label, recorded_at: recordedAt };
      const result = { event };
      overview.racks[rack] = { id, rack, action };
      await tx.set('state', rackId, { history: [{ ...event, actor_uid: actor.uid }, ...history].slice(0, fiveSHistoryLimit) });
      await tx.set('state', fiveSOverviewId, overview);
      await tx.set('ops', id, { actor_uid: actor.uid, fingerprint, created_at: recordedAt, result });
      return result;
    });
  }
  const snapshot = async knownLayoutRevision => {
    const state = await current(store), orders = await store.orders(state.orderIds.slice(0, 100));
    const board = boardForState(state);
    return { bins: Object.values(state.bins), orders: orders.filter(Boolean).map(publicOrder), events: state.events, ...settings(state), mailTokenConfigured: Boolean(config.MAILERSEND_API_KEY), mailReady: Boolean(config.MAILERSEND_API_KEY && settings(state).mailFrom), serverTime: clock(), todayCompleted: state.dailyCompleted.date === date8(clock()) ? state.dailyCompleted.count : 0,
      layoutRevision: board.layoutRevision,
      ...(Number.isInteger(knownLayoutRevision) && knownLayoutRevision !== board.layoutRevision ? { board: clone(board) } : {})
    };
  };
  async function saveLayout(b, actor) {
    fail(actor.role !== 'admin', '只有管理员可以发布货架配置。', 403);
    fail(!Number.isSafeInteger(b.layoutRevision) || b.layoutRevision < 0, '缺少有效的布局版本。');
    const nextCatalog = validateCatalog(b.catalog);
    const nextLayout = validateLayout(b.layout, nextCatalog);
    const layoutSource = typeof b.source === 'string' ? b.source.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 120) : '';
    fail(!layoutSource, '缺少导入文件名称。');
    const operationId = opId(b.operationId);
    const fingerprint = digest({ action: 'layout', revision: b.layoutRevision, nextCatalog, nextLayout, layoutSource });
    const now = clock();
    return store.transaction(async tx => {
      const previous = replay(await tx.get('ops', operationId), actor, fingerprint);
      if (previous) return previous;
      const state = await current(tx);
      const active = boardForState(state);
      requireLayoutRevision(active, b.layoutRevision);
      const conflicts = pendingConflicts(Object.values(state.bins), active.catalog, nextCatalog);
      const remaining = conflicts.length > 8 ? `等 ${conflicts.length} 个` : '';
      fail(conflicts.length, `库位 ${conflicts.slice(0, 8).join('、')}${remaining}还有待补料记录，请先处理再调整物料或数量。`, 409);
      const before = new Map(active.catalog.map(item => [item.BX, item]));
      const after = new Map(nextCatalog.map(item => [item.BX, item]));
      for (const location of Object.keys(state.bins)) {
        if (!after.has(location) || before.get(location)?.L !== after.get(location).L) delete state.bins[location];
      }
      const layoutRevision = active.layoutRevision + 1;
      state.board = { catalog: nextCatalog, layout: nextLayout, layoutRevision, layoutSource };
      addEvent(state, audit(actor, now, operationId, 'layout', '', `布局 v${layoutRevision} · ${nextLayout.length} 组货架 · ${nextCatalog.length} 个库位`));
      const result = { ok: true, layoutRevision };
      await tx.set('state', 'current', state);
      await tx.set('ops', operationId, { actor_uid: actor.uid, fingerprint, created_at: now, result });
      return result;
    });
  }
  async function changeBin(b, actor) {
    fail(typeof b.location !== 'string' || !['pending', 'full', 'cancel'].includes(b.target) || !Number.isInteger(b.expectedRevision) || b.expectedRevision < 0, '库位或状态无效。');
    fail(!permits(actor.role, b.target === 'full' ? 'refill' : 'report'), '此账号没有执行该操作的权限。', 403);
    const id = opId(b.operationId), now = clock(), fingerprint = digest({ action: 'bin', location: b.location, target: b.target, revision: b.expectedRevision, layoutRevision: b.layoutRevision });
    return store.transaction(async tx => {
      const previous = replay(await tx.get('ops', id), actor, fingerprint); if (previous) return previous;
      const state = await current(tx), board = boardForState(state);
      requireLayoutRevision(board, b.layoutRevision);
      fail(!board.catalog.some(item => item.BX === b.location), '库位不在当前物料表中。');
      const bin = clone(state.bins[b.location] || defaultBin(b.location));
      fail(bin.revision !== b.expectedRevision || bin.status !== (b.target === 'pending' ? 'full' : 'pending'), '料盒已被其他人更新，请刷新后重试。', 409);
      fail(b.target === 'cancel' && bin.request_id, '已生成补料单，请在补料模式确认补满。', 409);
      fail(b.target === 'cancel' && !permits(actor.role, 'cancelOthers') && bin.reported_by_uid !== actor.uid, '只能撤销本人尚未生成清单的报缺。', 403);
      if (b.target === 'full') await recordRefill(tx, state, bin.request_id, [b.location], now);
      updateBin(state, bin, b.target, actor, now, id);
      const result = { ok: true, bin };
      await tx.set('state', 'current', state); await tx.set('ops', id, { actor_uid: actor.uid, fingerprint, created_at: now, result });
      return result;
    });
  }
  async function confirmBins(b, actor) {
    fail(!permits(actor.role, 'refill'), '此账号没有确认补料的权限。', 403);
    fail(!Array.isArray(b.bins) || !b.bins.length || b.bins.length > MAX_LAYOUT_ITEMS ||
      b.bins.some(bin => typeof bin?.location !== 'string' || !Number.isSafeInteger(bin.expectedRevision) || bin.expectedRevision < 0),
    '请选择有效的待补料盒。');
    const targets = b.bins.map(({ location, expectedRevision }) => ({ location, expectedRevision }));
    const locations = targets.map(({ location }) => location);
    fail(new Set(locations).size !== locations.length, '同一库位只可提交一次。');
    const id = opId(b.operationId), now = clock();
    const fingerprint = digest({ action: 'confirm-bins', targets, layoutRevision: b.layoutRevision });
    return store.transaction(async tx => {
      const previous = replay(await tx.get('ops', id), actor, fingerprint);
      if (previous) return previous;
      const state = await current(tx), board = boardForState(state);
      requireLayoutRevision(board, b.layoutRevision);
      const allowed = new Set(board.catalog.map(item => item.BX));
      const bins = targets.map(({ location, expectedRevision }) => {
        const bin = state.bins[location];
        fail(!allowed.has(location) || bin?.status !== 'pending' || bin.revision !== expectedRevision,
          `库位 ${location} 状态已更新，请刷新后重新选择。`, 409);
        return bin;
      });
      const requestId = bins[0].request_id || null;
      // Keep each transaction bounded to one order, even for all-bin confirmation.
      fail(bins.some(bin => (bin.request_id || null) !== requestId), '料盒所属补料单已更新，请刷新后重新选择。', 409);
      await recordRefill(tx, state, requestId, locations, now);
      bins.forEach((bin, index) => updateBin(state, bin, 'full', actor, now, `${id}-${index}`));
      const result = { ok: true, count: bins.length };
      await tx.set('state', 'current', state);
      await tx.set('ops', id, { actor_uid: actor.uid, fingerprint, created_at: now, result });
      return result;
    });
  }
  async function createOrder(b, actor) {
    fail(!permits(actor.role, 'dispatch'), '此账号没有生成补料清单的权限。', 403);
    const operationId = opId(b.operationId), id = `BR-${operationId}`, now = clock();
    fail(!Array.isArray(b.locations) || !b.locations.length || b.locations.length > MAX_LAYOUT_ITEMS || new Set(b.locations).size !== b.locations.length || b.locations.some(v => typeof v !== 'string'), '请先标记有效的待补料盒。');
    const locations = [...b.locations].sort(compareLocation), fingerprint = digest({ action: 'order', locations, layoutRevision: b.layoutRevision });
    return store.transaction(async tx => {
      const previous = replay(await tx.get('ops', operationId), actor, fingerprint); if (previous) return previous;
      const state = await current(tx), board = boardForState(state);
      requireLayoutRevision(board, b.layoutRevision);
      const itemMap = new Map(board.catalog.map(item => [item.BX, item]));
      fail(locations.some(loc => !itemMap.has(loc)), '部分库位已不在当前物料表中。');
      fail(locations.some(loc => state.bins[loc]?.status !== 'pending' || state.bins[loc].request_id), '部分料盒状态已更新，请刷新后生成。', 409);
      const order = { id, created_at: now, created_by: actor.label, created_by_uid: actor.uid, items: locations.map(loc => clone(itemMap.get(loc))), status: 'prepared', recipient: settings(state).recipients, error: null, sent_at: null, completed_locations: [], deliveries: [] };
      for (const loc of locations) { state.bins[loc].request_id = id; state.bins[loc].revision++; state.bins[loc].updated_at = now; }
      state.orderIds = [id, ...state.orderIds.filter(v => v !== id)].slice(0, 100);
      addEvent(state, audit(actor, now, id, 'request', '', `${locations.length} 个库位 · ${id}`));
      const result = { ok: true, id };
      await tx.set('orders', id, order); await tx.set('state', 'current', state); await tx.set('ops', operationId, { actor_uid: actor.uid, fingerprint, created_at: now, result });
      return result;
    });
  }
  async function saveSettings(b, actor) {
    fail(actor.role !== 'admin', '只有管理员可以修改邮件地址设置。', 403);
    fail(['apiToken', 'token', 'apiKey'].some(k => k in b), '此接口不保存密钥；测试Token仅在本次页面使用。');
    const value = { recipients: recipients(b.recipients), mailFrom: fromEmail(b.mailFrom || ''), mailFromName: fromName(b.mailFromName || 'Bühler 补料看板') };
    await store.transaction(async tx => { const state = await current(tx); state.settings = value; await tx.set('state', 'current', state); });
    return { ok: true, ...value };
  }
  async function sendOrder(id, b, actor) {
    fail(!permits(actor.role, 'dispatch'), '此账号没有发信权限。', 403);
    const existing = await store.get('orders', id);
    fail(!existing, '补料单不存在。', 404);
    if (existing.status === 'sent') return { ok: true, alreadySent: true };
    fail(['sending', 'uncertain'].includes(existing.status), '本单发送结果待核实，请先到邮件平台核对，避免重复通知。', 409);
    fail(b.apiToken !== undefined && typeof b.apiToken !== 'string', 'API Token格式无效。');
    const token = (b.apiToken || config.MAILERSEND_API_KEY || '').trim();
    fail(!token, '请先填写本次MailerSend测试Token，或由管理员配置后台密钥。', 503);
    fail(!/^[^\s\x00-\x1f\x7f]{16,8192}$/.test(token), '请粘贴完整Token，不要包含Bearer前缀、空格或换行。');
    const prefs = settings(await current(store)), from = { email: fromEmail(prefs.mailFrom), name: fromName(prefs.mailFromName) };
    fail(!from.email, '请先由管理员保存测试发件邮箱。');
    const to = recipients(existing.recipient || prefs.recipients);
    fail(!to, '请先由管理员配置收件邮箱。');
    fail(b.recipients && recipients(b.recipients) !== to, '本单收件人已固定，请核对补料单记录。', 409);
    const targets = to.split('; '), attempt = randomUUID();
    const order = await store.transaction(async tx => {
      const row = await tx.get('orders', id);
      if (row.status === 'sent') return null;
      fail(!['prepared', 'failed', 'partial'].includes(row.status), '此补料单正在发送或结果待核实。', 409);
      row.recipient = to; row.status = 'sending'; row.error = null; row.sending_attempt = attempt;
      if (!row.deliveries.length) row.deliveries = targets.map(recipient => ({ recipient, status: 'prepared', provider_id: null, error: null, sent_at: null }));
      await tx.set('orders', id, row); return row;
    });
    if (!order) return { ok: true, alreadySent: true };
    const began = Date.now();
    const payload = { from, subject: `【Bühler 补料】${order.items.length} 个料盒 · ${id}`, text: mailText(order), attachments: [{ filename: `${id}.csv`, disposition: 'attachment', content: Buffer.from(csv(order.items), 'utf8').toString('base64') }] };
    const updateDelivery = async (email, updater) => store.transaction(async tx => {
      const row = await tx.get('orders', id);
      fail(row.sending_attempt !== attempt, '发送任务已更新，请核实。', 409);
      const delivery = row.deliveries.find(d => d.recipient === email);
      const outcome = updater(delivery);
      await tx.set('orders', id, row); return outcome;
    });
    for (const [index, email] of targets.entries()) {
      if (Date.now() - began > 35000) break;
      const claimed = await updateDelivery(email, d => { if (!['prepared', 'failed'].includes(d.status)) return false; d.status = 'sending'; d.error = null; return true; });
      if (!claimed) continue;
      let response;
      try { response = await fetchImpl('https://api.mailersend.com/v1/email', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ ...payload, to: [{ email }] }), signal: AbortSignal.timeout(15000) }); }
      catch { await updateDelivery(email, d => { d.status = 'uncertain'; d.error = '连接中断，平台是否接收未知。请先核对邮件平台记录，系统不会重复提交。'; }); break; }
      const parsed = await response.json().catch(() => ({})), result = parsed && typeof parsed === 'object' ? parsed : {};
      const messageId = response.headers.get('x-message-id'), allSuppressed = Array.isArray(result.warnings) && result.warnings.some(w => w?.type === 'ALL_SUPPRESSED');
      if (response.status !== 202 || !messageId) {
        const uncertain = !allSuppressed && (response.status >= 500 || response.ok);
        const error = allSuppressed ? '此收件人已被MailerSend抑制，本次未发出邮件。' : uncertain ? '平台是否接收尚未确认，请核对发信记录后处理。' : mailFailure(response.status, result, token);
        await updateDelivery(email, d => { d.status = uncertain ? 'uncertain' : 'failed'; d.error = error; });
        if (uncertain || [401, 403, 429].includes(response.status)) break;
        continue;
      }
      const warning = response.headers.get('x-send-paused') === 'true' ? '平台已接收，但当前暂停发送，请到MailerSend处理。' : Array.isArray(result.warnings) && result.warnings.length ? '平台返回收件人抑制提醒，请到MailerSend核对。' : null;
      await store.transaction(async tx => {
        const row = await tx.get('orders', id); fail(row.sending_attempt !== attempt, '发送任务已更新。', 409);
        const d = row.deliveries.find(v => v.recipient === email);
        d.status = 'sent'; d.provider_id = messageId; d.error = warning; d.sent_at = clock();
        const state = await current(tx); addEvent(state, audit(actor, clock(), `mail-${id}-${index}`, 'email', '', `${id} → ${email}`));
        await tx.set('orders', id, row); await tx.set('state', 'current', state);
      });
    }
    return store.transaction(async tx => {
      const row = await tx.get('orders', id); fail(row.sending_attempt !== attempt, '发送任务已更新。', 409);
      const sent = row.deliveries.filter(d => d.status === 'sent'), allSent = sent.length === targets.length;
      const uncertain = row.deliveries.some(d => ['sending', 'uncertain'].includes(d.status));
      const problem = row.deliveries.find(d => d.status !== 'sent' && d.error);
      const warning = allSent ? sent.filter(d => d.error).map(d => `${d.recipient}：${d.error}`).join('；') || null : null;
      row.status = allSent ? 'sent' : uncertain ? 'uncertain' : sent.length ? 'partial' : 'failed';
      row.sent_at = allSent ? clock() : null;
      row.error = allSent ? warning : `${sent.length}/${targets.length}位收件人已提交。${uncertain ? '存在未知结果，必须先核实，系统不会重复提交。' : '尚未全部提交；重试只处理未成功的收件人。'}${problem ? ` ${problem.recipient}：${problem.error}` : ''}`;
      await tx.set('orders', id, row);
      // Returning the failure after committing preserves per-recipient receipts.
      return { mailResult: true, ok: allSent, error: row.error, warning, submitted: sent.length, total: targets.length };
    });
  }
  return async function invoke(event, identity, startedAt = Date.now()) {
    try {
      fail(!event || typeof event !== 'object' || Array.isArray(event), '请求格式无效。');
      if (event.path === '/health' && event.method === 'GET') return { status: 200, data: { ok: true, version: API_VERSION, authorizationConfigured: access.configured } };
      const actor = await access.authorize(identity);
      const method = event.method, path = event.path, b = event.body || {};
      const sizeLimit = method === 'POST' && path === '/api/layout' ? MAX_LAYOUT_BYTES : 65_536;
      fail(typeof path !== 'string' || !['GET', 'POST'].includes(method) || typeof b !== 'object' || Array.isArray(b) || Buffer.byteLength(JSON.stringify(b)) > sizeLimit, '请求格式无效或内容超过大小限制。');
      if (method === 'POST' && path === '/api/arims') {
        fail(actor.role !== 'admin', 'ARIMS 接口调试仅对管理员开放。', 403);
        return await invokeArims(b, fetchImpl, startedAt);
      }
      let data;
      if (method === 'GET' && path === '/api/bootstrap') {
        const { uid, role, label, authMethod } = actor;
        data = { actor: { uid, role, label, authMethod }, ...clone(boardForState(await current(store))) };
      }
      else if (method === 'GET' && path === '/api/state') data = await snapshot(b.layoutRevision);
      else if (method === 'GET' && path === '/api/five-s') data = await readFiveS(b);
      else if (method === 'POST' && path === '/api/five-s') data = await recordFiveS(b, actor);
      else if (method === 'GET' && path === '/api/access') data = await access.overview(actor);
      else if (method === 'POST' && path === '/api/access/member') data = await access.editMember(actor, b, { upsert: true });
      else if (method === 'POST' && path === '/api/access/member/save') data = await access.editMember(actor, b);
      else if (method === 'POST' && path === '/api/access/member/remove') data = await access.removeMember(actor, b);
      else if (method === 'POST' && path === '/api/access/face') data = await access.editFace(actor, b);
      else if (method === 'GET' && path === '/api/face/profile') data = await access.ownFace(actor);
      else if (method === 'POST' && path === '/api/face/enroll') data = await face.enrollmentGrant(actor, b);
      else if (method === 'POST' && path === '/api/face/withdraw') data = await access.editFace(actor, b, true);
      else if (method === 'POST' && path === '/api/layout') data = await saveLayout(b, actor);
      else if (method === 'POST' && path === '/api/bin') data = await changeBin(b, actor);
      else if (method === 'POST' && path === '/api/bin/confirm') data = await confirmBins(b, actor);
      else if (method === 'POST' && path === '/api/requests') data = await createOrder(b, actor);
      else if (method === 'POST' && path === '/api/settings') data = await saveSettings(b, actor);
      else if (method === 'POST' && /^\/api\/requests\/[A-Za-z0-9_-]{1,100}\/send$/.test(path)) data = await sendOrder(path.split('/')[3], b, actor);
      else throw new AppError('接口不存在。', 404);
      if (data?.mailResult && !data.ok) return { status: 502, data: { error: data.error, submitted: data.submitted, total: data.total } };
      return { status: 200, data };
    } catch (error) {
      if (error instanceof AppError) return { status: error.status, data: { error: error.message } };
      if (error instanceof LayoutError) return { status: 400, data: { error: error.message, issues: error.issues.slice(0, 12) } };
      // Do not log request bodies, tokens, or raw provider replies.
      return { status: 500, data: { error: '后台操作未完成。请管理员检查集合、权限和云函数配置，再刷新重试。' } };
    }
  };
}
