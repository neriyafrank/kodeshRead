export interface CopyItem {
  bookTitle: string;
  tocPath?: string | null;
  html: string;
}
export function plainText(html: string | null | undefined): string;
export function locationOf(tocPath: string | null | undefined, bookTitle: string): string;
export function citationLine(bookTitle: string, location: string): string;
export function formatCopy(items: CopyItem[], opts?: { citation?: boolean }): string;
