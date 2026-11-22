import type { SQLiteDatabase } from 'expo-sqlite';

/** Closes a connection, ignoring "already closed" errors. */
export async function closeQuietly(db: SQLiteDatabase | null | undefined): Promise<void> {
  if (!db) return;
  try {
    await db.closeAsync();
  } catch {
    // already closed
  }
}

/** Lets the JS thread render a frame between heavy steps. */
export const nextFrame = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
