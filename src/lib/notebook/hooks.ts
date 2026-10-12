/**
 * How the tabs store reaches notebooks without loading the notebook
 * editor (which is lazy-loaded with Monaco): the notebook module fills
 * these in when it loads. A notebook tab only exists once its view has
 * rendered, so the hooks are set by the time they're needed.
 */
export interface NotebookHooks {
  /** Write the notebook to disk. */
  save?: (path: string) => Promise<void>;
  /** The last tab showing the notebook closed: shut its kernel down. */
  close?: (path: string) => void;
  /** The file moved: follow it. */
  rename?: (oldPath: string, newPath: string) => void;
  /** Run a notebook command (palette) on a notebook. */
  command?: (path: string, command: NotebookCommand) => void;
}

export type NotebookCommand =
  | "runAll"
  | "runCell"
  | "interrupt"
  | "restart"
  | "restartRunAll"
  | "clearOutputs"
  | "selectKernel";

export const notebookHooks: NotebookHooks = {};

/** Files that open in the notebook editor. */
export const isNotebookPath = (path: string) => /\.ipynb$/i.test(path);

/** The tab key of a notebook tab (the file tab, "Open as Text", keeps the path). */
export const notebookTabKey = (path: string) => `notebook:${path}`;
