/** Canonical book-role classification (see bookRoles.js). */
import type { ParallelMember } from './parallelWorks';

export type BookRole = 'base' | 'parallel' | 'commentary' | 'targum';
export const ROLES: { BASE: 'base'; PARALLEL: 'parallel'; COMMENTARY: 'commentary'; TARGUM: 'targum' };
export const ROLE_LABELS: Record<BookRole, string>;
export function isTargum(info: { title: string; categoryPath?: string }, place?: object): boolean;
export function commentaryContext(place: object): boolean;
export function classifyBooks(
  infos: { id: number; title: string; categoryPath?: string }[],
  pairResult: { pairs: { commId: number; baseId: number; how: string }[]; multi: { commId: number; scope: object }[] },
): { roles: Map<number, BookRole>; baseOf: Map<number, number>; general: Set<number>; members: Map<number, ParallelMember> };
export function relationOf(fromRole: BookRole, toRole: BookRole, toIsBaseOfFrom?: boolean): 'parallel' | 'targum' | 'commentary' | 'source';
