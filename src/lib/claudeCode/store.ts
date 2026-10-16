import { create } from "zustand";

/** Claude Code (Anthropic's CLI) in this window: the IDE server and who's connected. */
interface ClaudeCodeState {
  /** The IDE server's port, once it runs. */
  port: number | null;
  /** CLIs connected to this window. */
  clients: number;
  /** Their process ids (from the CLI's ide_connected notification). */
  pids: number[];
  /** The install help panel (the CLI wasn't found). */
  installOpen: boolean;
  /** Why the CLI couldn't be started (a bad path in Settings…). */
  installError: string | null;
  /** Proposed changes waiting for Accept / Reject, by request id. */
  proposals: Record<string, ProposalInfo>;
  showInstall: (error?: string | null) => void;
  hideInstall: () => void;
}

export interface ProposalInfo {
  filePath: string;
  tabName: string;
  isNewFile: boolean;
  status: "pending" | "accepted" | "rejected" | "closed";
}

export const useClaudeCodeStore = create<ClaudeCodeState>((set) => ({
  port: null,
  clients: 0,
  pids: [],
  installOpen: false,
  installError: null,
  proposals: {},
  showInstall: (error = null) => set({ installOpen: true, installError: error }),
  hideInstall: () => set({ installOpen: false, installError: null }),
}));
