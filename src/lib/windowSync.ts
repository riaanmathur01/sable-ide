import { listen } from "./events";
import { forgetWindowWhenClosed, saveWindowState, setWindowTitle, windowLabel } from "./windows";
import { folderName, folderOf, onFoldersChange, useWorkspaceStore } from "../store/workspaceStore";
import { useTabsStore } from "../store/tabsStore";
import { repositoryRoot, useGitStore } from "../store/gitStore";
import { useRemoteStore } from "../store/remoteStore";
import { useSettingsStore } from "../store/settingsStore";
import { useShortcutStore } from "./shortcuts";
import { usePluginStore } from "../store/pluginStore";

/**
 * Keep this window's record (what to reopen at the next launch) and title
 * current, and follow changes other windows make to what they share:
 * settings.json, keybindings.json and the installed plugins.
 */
let started = false;

export function startWindowSync(): void {
  if (started) return;
  started = true;

  const save = () => {
    const { folders, workspaceFile, rootPath } = useWorkspaceStore.getState();
    const remote = useRemoteStore.getState();
    const onRemote = remote.status === "connected" && remote.target && rootPath;
    saveWindowState({
      folders,
      workspaceFile,
      remote: onRemote ? { target: remote.target!, folder: rootPath! } : null,
    });
    const name = workspaceFile
      ? `${(workspaceFile.split(/[/\\]/).pop() ?? workspaceFile).replace(/\.code-workspace$/, "")} (Workspace)`
      : rootPath
        ? folderName(rootPath)
        : null;
    const where = onRemote && remote.label ? ` [${remote.label}]` : "";
    setWindowTitle(name ? `${name}${where} — Sable` : "Sable");
  };
  save();
  useWorkspaceStore.subscribe((state, previous) => {
    if (state.folders !== previous.folders || state.workspaceFile !== previous.workspaceFile) save();
  });
  useRemoteStore.subscribe((state, previous) => {
    if (state.status !== previous.status || state.target !== previous.target) save();
  });
  forgetWindowWhenClosed();

  // Multi-root: Source Control shows the active file's repository, and
  // follows folders being added and removed.
  useTabsStore.subscribe((state, previous) => {
    if (state.activePath === previous.activePath || !state.activePath) return;
    if (useWorkspaceStore.getState().folders.length < 2) return;
    const folder = folderOf(state.activePath);
    if (folder && folder !== repositoryRoot()) useGitStore.getState().setRepository(folder);
  });
  onFoldersChange(() => useGitStore.getState().refresh());

  const fromElsewhere = (payload: unknown) => (payload as { from?: string } | null)?.from !== windowLabel;
  void listen("sable:settings-changed", ({ payload }) => {
    if (fromElsewhere(payload)) void useSettingsStore.getState().load();
  });
  void listen("sable:keybindings-changed", ({ payload }) => {
    if (fromElsewhere(payload)) void useShortcutStore.getState().load();
  });
  void listen("sable:plugins-changed", ({ payload }) => {
    if (fromElsewhere(payload)) void usePluginStore.getState().syncInstalled();
  });
}
