import type { SearchScope } from './search';

export type SearchStage = 'query' | 'verify' | 'count';
export type SearchPhase = 'idle' | 'searching' | 'done' | 'cancelled';

export interface LifecycleResults {
  key: string;
  rows: any[];
  terms: string[];
  hasMore: boolean;
  cursor: any;
  count: { count: number; capped: boolean } | null;
  elapsed: number;
  error?: string;
}
export interface Lifecycle {
  status: SearchPhase;
  id: number;
  key: string;
  stage: SearchStage;
  scanned: number;
  startedAt: number;
  counting: boolean;
  results: LifecycleResults | null;
}
export type LifecycleAction =
  | { type: 'start'; id: number; key: string; now: number }
  | { type: 'progress'; id: number; stage: SearchStage; scanned?: number }
  | { type: 'page'; id: number; results: LifecycleResults }
  | { type: 'count'; id: number; count: { count: number; capped: boolean } }
  | { type: 'more'; id: number; rows: any[]; hasMore: boolean; cursor: any }
  | { type: 'cancel'; id: number };

export const BANNER_DELAY_MS: number;
export const STAGE_LABELS: Record<SearchStage, string>;
export function createRequestCounter(): { next(): number; current(): number; isCurrent(id: number): boolean };
export function initialLifecycle(): Lifecycle;
export function lifecycleReducer(state: Lifecycle, a: LifecycleAction): Lifecycle;
export function viewOf(state: Lifecycle, key: string, idle: boolean): { phase: SearchPhase; current: LifecycleResults | null; shown: LifecycleResults | null };
export function scopeSearchLabel(scope: SearchScope | null | undefined): string;
export function stageLabel(stage: SearchStage, scanned: number, scope: SearchScope | null | undefined): string;
export function isolateLtr(text: string): string;
export function formatElapsed(ms: number): string;
