import { create } from "zustand";
import type { ContextMenuItem } from "../components/ContextMenu/ContextMenu";

/** A menu at the cursor for choosing between refactorings (e.g. which
 *  scope to extract to). Rendered by App with the ContextMenu. */
interface RefactorPickerState {
  menu: { x: number; y: number; items: ContextMenuItem[] } | null;
  open: (x: number, y: number, items: ContextMenuItem[]) => void;
  close: () => void;
}

export const useRefactorPickerStore = create<RefactorPickerState>((set) => ({
  menu: null,
  open: (x, y, items) => set({ menu: { x, y, items } }),
  close: () => set({ menu: null }),
}));
