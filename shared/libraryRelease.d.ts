import type { CloudPackageView } from './multipart';
export const LIBRARY_SCOPE: 'all';
export const LIBRARY_TAG: string;
export const MANIFEST_NAME: string;
export const LIBRARY_TITLE: string;
export const LIBRARY_INCLUDES: string;

export function libraryManifestUrl(repo: string): string;
export function tagOfManifestUrl(url: string): string | null;
export function normalizeInstalledCloud(recorded: unknown): { version: string; stage?: 'core' | 'full' } | null;
export function isPartialScope(scope: string | null | undefined): boolean;

export const STAGE_TITLES: { core: string; extended: string; full: string };
export type Plan = 'core' | 'extended' | 'full';
export type InstalledStage = 'none' | 'core' | 'full' | 'partial';
export interface InstalledState {
  stage: InstalledStage;
  version: string | null;
  /** A monolithic / older install (no `part` meta): treated as the complete library. */
  legacy: boolean;
  /** An extended database of another build is installed next to the core one (ignored, replaced on update). */
  extendedStale: boolean;
}
export function libraryState(a: {
  coreInfo: { version: string; scope?: string | null; part?: string | null } | null;
  extendedInfo?: { version: string } | null;
  recorded?: { version: string; stage?: string } | null;
}): InstalledState;
export type LibraryMode = 'choose' | 'expand' | 'update' | 'current';
export function libraryAction(a: { state: InstalledState; manifest: { version: string; extended?: unknown | null } }): { mode: LibraryMode; plans: Plan[] };
export function flowOf(a: { state: InstalledState; manifest: { version: string; extended?: unknown | null }; plan: Plan }): { packages: ('core' | 'extended')[]; installAsYouGo: boolean };

export function runStagedFlow(a: {
  state: InstalledState;
  manifest: { version: string; extended?: unknown | null };
  plan: Plan;
  stage: (pkg: CloudPackageView, window: { offset: number; total: number; label: string }) => Promise<void>;
  install: (pkg: CloudPackageView) => Promise<void>;
}): Promise<{ kinds: ('core' | 'extended')[]; installed: ('core' | 'extended')[]; total: number; books: number }>;
