export type Edition = 'classic' | 'full';

export interface EditionInfo {
  id: Edition;
  scope: 'classical_full' | 'all';
  tag: string;
  title: string;
  includes: string;
}

export const EDITIONS: Record<Edition, EditionInfo>;
export const EDITION_IDS: Edition[];
export const MANIFEST_NAME: string;

export function isEdition(e: unknown): e is Edition;
export function assertEdition(e: unknown): Edition;
export function editionTag(edition: Edition): string;
export function editionScope(edition: Edition): string;
export function editionOfScope(scope: string | null | undefined): Edition | null;
export function editionOfManifest(m: { edition?: string | null; scope?: string | null } | null | undefined): Edition | null;
export function editionManifestUrl(repo: string, edition: Edition): string;
export function tagOfManifestUrl(url: string): string | null;
export function editionOfUrl(url: string): Edition | null;
export function installedEdition(
  info: { scope?: string | null; version?: string | null } | null,
  recorded: { edition?: string; version?: string } | null,
): Edition | null;

export type EditionAction = 'install' | 'current' | 'update' | 'switch';
export function editionAction(args: {
  installedEdition: Edition | null;
  installedVersion: string | null;
  manifest: { version: string; edition?: string | null; scope?: string | null };
}): EditionAction;
