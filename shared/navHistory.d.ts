export const HOME: 'home';
export type NavHref = string | { pathname: string; params?: Record<string, unknown> };
export function screenOf(href: NavHref): string;
export function createHistory(): string[];
export function open(stack: string[], href: NavHref): string[];
export function systemBack(stack: string[]): { stack: string[]; handled: boolean };
export function appBack(): string[];
