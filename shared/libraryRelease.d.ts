export const LIBRARY_SCOPE: 'all';
export const LIBRARY_TAG: string;
export const MANIFEST_NAME: string;
export const LIBRARY_TITLE: string;
export const LIBRARY_INCLUDES: string;

export function libraryManifestUrl(repo: string): string;
export function tagOfManifestUrl(url: string): string | null;
export function normalizeInstalledCloud(recorded: unknown): { version: string } | null;
export function isPartialScope(scope: string | null | undefined): boolean;

export type LibraryAction = 'install' | 'current' | 'update';
export function libraryAction(args: {
  installedScope?: string | null;
  installedVersion: string | null;
  manifest: { version: string };
}): LibraryAction;
