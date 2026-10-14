import { create } from "zustand";
import type { RefactoringPlan, Signature, UsageItem } from "../lib/refactorings/types";

/**
 * The dialogs of the deeper refactorings (rendered by
 * components/Refactoring/RefactoringDialogs): Safe Delete's usages,
 * Change Signature, Move's target picker, the Refactoring Preview, and
 * the "Undo" toast after applying.
 */

export type RefactoringDialog =
  | {
      kind: "safeDelete";
      /** "function used_helper", "file pricing.py". */
      what: string;
      usages: UsageItem[];
      /** No usages, but confirm anyway (files). */
      confirmOnly?: boolean;
      deleteAnyway: () => Promise<void>;
    }
  | {
      kind: "changeSignature";
      signature: Signature;
      /** "Rope", "TypeScript", "text-based (language server references)". */
      engine: string;
      /** Text-based: labeled as best effort. */
      bestEffort: boolean;
      /** Builds the plan; the preview follows. */
      submit: (signature: Signature) => Promise<void>;
    }
  | {
      kind: "move";
      /** What's moving: "function used_helper". */
      what: string;
      sourcePath: string;
      /** Extensions a target may have (".py"). */
      extensions: string[];
      submit: (target: string) => Promise<void>;
    }
  | {
      kind: "preview";
      plan: RefactoringPlan;
      /** The main button ("Do Refactor"). */
      applyLabel?: string;
      apply: () => Promise<void>;
      /** A second way out ("Rename Only"). */
      alternative?: { label: string; run: () => Promise<void> };
    };

interface RefactoringState {
  dialog: RefactoringDialog | null;
  /** Work in progress ("Finding usages…"), shown over the dialog. */
  busy: string | null;
  /** An error to show in the open dialog. */
  error: string | null;
  toast: { message: string; undo?: () => void } | null;
  open: (dialog: RefactoringDialog) => void;
  close: () => void;
  setBusy: (busy: string | null) => void;
  setError: (error: string | null) => void;
  showToast: (message: string, undo?: () => void) => void;
  hideToast: () => void;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

export const useRefactoringStore = create<RefactoringState>((set) => ({
  dialog: null,
  busy: null,
  error: null,
  toast: null,
  open: (dialog) => set({ dialog, busy: null, error: null }),
  close: () => set({ dialog: null, busy: null, error: null }),
  setBusy: (busy) => set({ busy }),
  setError: (error) => set({ error, busy: null }),
  showToast: (message, undo) => {
    clearTimeout(toastTimer);
    set({ toast: { message, undo } });
    toastTimer = setTimeout(() => set({ toast: null }), 12_000);
  },
  hideToast: () => {
    clearTimeout(toastTimer);
    set({ toast: null });
  },
}));
