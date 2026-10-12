/**
 * How to run a command palette entry by id — set by the palette, used by
 * keyboard shortcuts. Its own module with no imports, so module load
 * order (the palette and the shortcuts import each other indirectly)
 * can't reset it.
 */
export const paletteRunner: { run: ((id: string) => boolean) | null } = { run: null };
