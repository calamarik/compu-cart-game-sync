export type SyncAction = "pull" | "push" | "skip";
export type SyncItem = { file: string; action: SyncAction };

/** Same rule as electron/core.cjs: newest wins, 2s tolerance (FAT32). */
export function planSync(local: Record<string, number>, cart: Record<string, number>, toleranceMs = 2000): SyncItem[] {
  const files = new Set([...Object.keys(local), ...Object.keys(cart)]);
  return [...files].map((file) => {
    const l = local[file], c = cart[file];
    if (l === undefined) return { file, action: "pull" };
    if (c === undefined) return { file, action: "push" };
    if (c - l > toleranceMs) return { file, action: "pull" };
    if (l - c > toleranceMs) return { file, action: "push" };
    return { file, action: "skip" };
  });
}
