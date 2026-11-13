export const roleLabels = Object.freeze({
  worker: '现场工人',
  lead: '布勒线长',
  refill: '补料员',
  admin: '项目管理员',
  inspector: '巡检员（旧版）',
  operator: '通用操作员（旧版）'
});

const permissions = {
  worker: ['report', 'recordFiveS'],
  lead: ['report', 'cancelOthers', 'dispatch', 'inspectFiveS'],
  refill: ['refill'],
  admin: ['report', 'cancelOthers', 'dispatch', 'refill', 'manage', 'recordFiveS', 'inspectFiveS'],
  inspector: ['report', 'cancelOthers', 'dispatch', 'inspectFiveS'],
  operator: ['report', 'cancelOthers', 'dispatch', 'refill', 'recordFiveS']
};

export function permits(role, action) {
  return Object.hasOwn(permissions, role) && permissions[role].includes(action);
}
