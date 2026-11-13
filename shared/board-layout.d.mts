import type { Item, Rack } from '../src/lib/model';

export const MAX_LAYOUT_ITEMS: number;
export const MAX_LAYOUT_RACKS: number;
export const MAX_SHELF_ROWS: number;
export const GRID_COLUMNS: number;
export const MAX_LAYOUT_BYTES: number;
export const AUTO_ROW_OPTIONS: number[];
export class LayoutError extends Error {
  constructor(issues: string[]);
  issues: string[];
}
export function normalizeLocation(value: unknown): string;
export function compareLocation(a: string, b: string): number;
export function validateCatalog(items: unknown): Item[];
export function validateLayout(layout: unknown, catalog: Item[]): Rack[];
export function retainLayout(layout: Rack[], catalog: Item[]): Rack[];
export function autoLayout(catalog: Item[], boxesPerShelf?: number): Rack[];
export function pendingConflicts(bins: { location: string; status: string }[], current: Item[], incoming: Item[]): string[];
