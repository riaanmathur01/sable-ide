import { create } from "zustand";
import type { Rgba } from "../lib/colorPicker/colors";

/**
 * The color picker popup (components/ColorPicker): where it shows, the
 * color it starts from, and what to do as the color changes. The editor
 * side (lib/colorPicker/editorColors.ts) opens it.
 */
export interface ColorPickerRequest {
  /** Screen position of the slot (the popup opens below it). */
  x: number;
  y: number;
  lineHeight: number;
  /** The color there (null: an empty slot; the picker starts from the last one used). */
  initial: Rgba | null;
  /** Colors already in this file, offered as swatches. */
  documentColors: string[];
  /** Show `text` in the code while picking. */
  preview: (text: string) => void;
  /** Keep `text` (Insert, Enter, or clicking away). */
  commit: (text: string) => void;
  /** Put back what was there (Escape). */
  cancel: () => void;
}

interface ColorPickerState {
  request: ColorPickerRequest | null;
  open: (request: ColorPickerRequest) => void;
  close: () => void;
}

export const useColorPickerStore = create<ColorPickerState>((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
}));
