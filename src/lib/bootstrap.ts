import type { Role } from '../../shared/access.mjs';

export type Actor = { uid: string; role: Role; label: string; authMethod?: 'password' | 'face' };
