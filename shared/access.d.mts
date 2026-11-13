export type Role = 'worker' | 'lead' | 'refill' | 'admin' | 'inspector' | 'operator';
export const roleLabels: Readonly<Record<Role, string>>;
export function permits(role: Role, action: 'report' | 'cancelOthers' | 'dispatch' | 'refill' | 'manage' | 'recordFiveS' | 'inspectFiveS'): boolean;
