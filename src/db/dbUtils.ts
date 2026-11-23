import { AppState } from 'react-native';
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

/**
 * Yield between books of a long import. In the foreground: a short timeout so the UI keeps
 * rendering at 60fps and the GC can run. In the background (kept alive by the import foreground
 * service) React Native pauses JS timers, so a timeout would stall the import: a microtask hop
 * is enough there, since every SQLite / file call is already an async native round trip.
 */
export function yieldToUI(ms = 15): Promise<void> {
  if (AppState.currentState !== 'active') return Promise.resolve();
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
