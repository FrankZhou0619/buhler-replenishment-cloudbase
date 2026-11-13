export type FiveSAction = 'complete' | 'pass' | 'rework' | 'correct';
export type FiveSSummary = { id: string; rack: number; action: FiveSAction };
export type FiveSEvent = FiveSSummary & { note: string; operator: string; recorded_at: string };
export type FiveSRecords = { latest: FiveSSummary[]; history: FiveSEvent[] };
export const fiveSHistoryLimit: number;
export const fiveSActions: Record<FiveSAction, {
  label: string; previous: (FiveSAction | null)[]; permission: 'recordFiveS' | 'inspectFiveS';
}>;
