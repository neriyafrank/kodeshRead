export function tabLocation(tocPath: string | null | undefined, max?: number): string;
export function tabSubtitle(tocPath: string | null | undefined): string;
export function filterTabs<T extends { bookTitle: string; tocPath?: string | null }>(tabs: T[], query: string, categoryOf?: (tab: T) => string | undefined): T[];
