import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, ArrowDown, ArrowRight, ArrowUp, ChevronDown, ChevronRight, FilePlus2, Plus, Undo2, X } from "lucide-react";
import { useRefactoringStore, type RefactoringDialog } from "../../store/refactoringStore";
import { useWorkspaceStore, workspaceRelativePath } from "../../store/workspaceStore";
import { goTo } from "../../store/navigationStore";
import { iconForFile } from "../../lib/fileIcons";
import { fuzzyScore } from "../../lib/fuzzy";
import { listWorkspaceFiles, parentDirectoryOf } from "../../lib/ipc";
import { countChanges, hunks } from "../../lib/refactorings/diff";
import { formatSignature, markEdited, newParamId, validateSignature } from "../../lib/refactorings/signature";
import { showUsagesInPanel } from "../../lib/refactorings";
import type { PlannedFile, RefactoringPlan, Signature, SignatureParam, UsageItem } from "../../lib/refactorings/types";
import "./RefactoringDialogs.css";

/**
 * The deeper refactorings' dialogs: Safe Delete's usages, Change
 * Signature, Move's target picker, the Refactoring Preview — and the
 * "Undo" toast after applying one.
 */
export function RefactoringDialogs() {
  const dialog = useRefactoringStore((state) => state.dialog);
  const toast = useRefactoringStore((state) => state.toast);
  return (
    <>
      {dialog && <Dialog dialog={dialog} />}
      {toast && (
        <div className="rf-toast" role="status">
          <span>{toast.message}</span>
          {toast.undo && (
            <button className="rf-toast-undo" onClick={toast.undo}>
              <Undo2 size={13} strokeWidth={1.8} /> Undo
            </button>
          )}
          <button className="rf-icon-button" title="Dismiss" onClick={() => useRefactoringStore.getState().hideToast()}>
            <X size={13} strokeWidth={1.8} />
          </button>
        </div>
      )}
    </>
  );
}

function Dialog({ dialog }: { dialog: RefactoringDialog }) {
  switch (dialog.kind) {
    case "safeDelete":
      return <SafeDeleteDialog dialog={dialog} />;
    case "changeSignature":
      return <ChangeSignatureDialog dialog={dialog} />;
    case "move":
      return <MoveDialog dialog={dialog} />;
    case "preview":
      return <PreviewDialog dialog={dialog} />;
  }
}

const close = () => useRefactoringStore.getState().close();

/** Run a dialog's action: busy while it runs, its error shown in the dialog. */
async function run(label: string, action: () => Promise<void>) {
  const store = useRefactoringStore.getState();
  store.setError(null);
  store.setBusy(label);
  try {
    await action();
    if (useRefactoringStore.getState().busy === label) useRefactoringStore.getState().setBusy(null);
  } catch (error) {
    useRefactoringStore.getState().setError(error instanceof Error ? error.message : String(error));
  }
}

function Frame({
  title,
  subtitle,
  badge,
  width,
  children,
  footer,
  onSubmit,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  badge?: string;
  width?: number;
  children: ReactNode;
  footer: ReactNode;
  onSubmit?: () => void;
  className?: string;
}) {
  const busy = useRefactoringStore((state) => state.busy);
  const error = useRefactoringStore((state) => state.error);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !useRefactoringStore.getState().busy) {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);
  return (
    <div className="rf-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busy && close()}>
      <form
        className={`rf-dialog ${className ?? ""}`}
        style={width ? { width } : undefined}
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) onSubmit?.();
        }}
      >
        <header className="rf-header">
          <div className="rf-title-block">
            <div className="rf-title">{title}</div>
            {subtitle && <div className="rf-subtitle">{subtitle}</div>}
          </div>
          {badge && <span className="rf-badge" title="How this refactoring is worked out">{badge}</span>}
          <button type="button" className="rf-icon-button" title="Close (Esc)" onClick={close} disabled={!!busy}>
            <X size={14} strokeWidth={1.8} />
          </button>
        </header>
        <div className="rf-body">{children}</div>
        {error && (
          <div className="rf-error">
            <AlertTriangle size={13} strokeWidth={1.8} />
            <span>{error}</span>
          </div>
        )}
        <footer className="rf-footer">
          {busy && <span className="rf-busy">{busy}</span>}
          {footer}
        </footer>
      </form>
    </div>
  );
}

function relative(path: string): string {
  return workspaceRelativePath(path);
}

function FileName({ path, note }: { path: string; note?: ReactNode }) {
  const name = path.split(/[/\\]/).pop() ?? path;
  const Icon = iconForFile(name);
  const directory = relative(path).slice(0, -name.length).replace(/[/\\]$/, "");
  return (
    <span className="rf-file-name">
      <Icon size={13} strokeWidth={1.6} className="rf-file-icon" />
      <span className="rf-file-base">{name}</span>
      {directory && <span className="rf-file-dir">{directory}</span>}
      {note}
    </span>
  );
}

// --- Safe Delete ---------------------------------------------------------------------------

function groupByFile(usages: UsageItem[]): [string, UsageItem[]][] {
  const byFile = new Map<string, UsageItem[]>();
  for (const usage of usages) byFile.set(usage.path, [...(byFile.get(usage.path) ?? []), usage]);
  return [...byFile.entries()];
}

function UsagePreview({ usage }: { usage: UsageItem }) {
  const text = usage.preview;
  const indent = text.length - text.trimStart().length;
  const start = Math.max(usage.column - 1, indent);
  const end = Math.max(start, usage.endColumn - 1);
  return (
    <span className="rf-code">
      {text.slice(indent, start)}
      <mark>{text.slice(start, end)}</mark>
      {text.slice(end)}
    </span>
  );
}

function SafeDeleteDialog({ dialog }: { dialog: Extract<RefactoringDialog, { kind: "safeDelete" }> }) {
  const busy = useRefactoringStore((state) => state.busy);
  const groups = useMemo(() => groupByFile(dialog.usages), [dialog.usages]);
  const count = dialog.usages.length;
  const remove = () => void run("Deleting…", dialog.deleteAnyway);
  if (dialog.confirmOnly) {
    return (
      <Frame
        title="Safe Delete"
        width={460}
        onSubmit={remove}
        footer={
          <>
            <button type="button" className="rf-button" onClick={close} disabled={!!busy}>
              Cancel
            </button>
            <button type="submit" className="rf-button danger" autoFocus disabled={!!busy}>
              Delete
            </button>
          </>
        }
      >
        <p className="rf-message">
          Nothing uses <strong>{dialog.what}</strong>. Delete it?
        </p>
      </Frame>
    );
  }
  return (
    <Frame
      title="Safe Delete"
      subtitle={
        <>
          <strong>{dialog.what}</strong> has {count} usage{count === 1 ? "" : "s"} in {groups.length} file{groups.length === 1 ? "" : "s"}. Deleting it
          anyway will break {count === 1 ? "it" : "them"}.
        </>
      }
      width={720}
      onSubmit={remove}
      className="rf-safe-delete"
      footer={
        <>
          <button type="button" className="rf-button" onClick={close} disabled={!!busy}>
            Cancel
          </button>
          <button
            type="button"
            className="rf-button"
            disabled={!!busy}
            onClick={() => {
              showUsagesInPanel(dialog.what.split(" ").pop() ?? dialog.what, dialog.usages);
              close();
            }}
          >
            View Usages
          </button>
          <button type="submit" className="rf-button danger" disabled={!!busy}>
            Delete Anyway
          </button>
        </>
      }
    >
      <div className="rf-list">
        {groups.map(([path, usages]) => (
          <div key={path} className="rf-group">
            <div className="rf-group-header">
              <FileName path={path} />
              <span className="rf-count">{usages.length}</span>
            </div>
            {usages.map((usage) => (
              <button
                type="button"
                key={`${usage.line}:${usage.column}`}
                className="rf-usage"
                title="Go to this usage"
                onClick={() => {
                  close();
                  void goTo(usage.path, usage.line, usage.column);
                }}
              >
                <span className="rf-line-number">{usage.line}</span>
                <UsagePreview usage={usage} />
                {usage.kind && usage.kind !== "reference" && <span className="rf-usage-kind">{usage.kind}</span>}
              </button>
            ))}
          </div>
        ))}
      </div>
    </Frame>
  );
}

// --- Change Signature ---------------------------------------------------------------------------

const KIND_LABELS: Partial<Record<SignatureParam["kind"], string>> = {
  positional: "positional",
  kwonly: "keyword-only",
  posonly: "positional-only",
};

function ChangeSignatureDialog({ dialog }: { dialog: Extract<RefactoringDialog, { kind: "changeSignature" }> }) {
  const busy = useRefactoringStore((state) => state.busy);
  const original = dialog.signature;
  const [signature, setSignature] = useState<Signature>(() => ({ ...original, params: original.params.map((param) => ({ ...param })) }));
  const [selected, setSelected] = useState<string | null>(signature.params[0]?.id ?? null);
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => nameInput.current?.select(), []);
  const python = signature.language === "python";
  const typed = signature.language !== "javascript" && signature.language !== "ruby";
  const problem = validateSignature(signature);
  const columns = { gridTemplateColumns: ["1.2fr", typed && "1.1fr", "0.9fr", "0.9fr", python && "112px", "auto"].filter(Boolean).join(" ") };
  const changed = useMemo(() => JSON.stringify(signature) !== JSON.stringify(original), [signature, original]);

  const update = (id: string, patch: Partial<SignatureParam>) =>
    setSignature((current) => ({
      ...current,
      params: current.params.map((param) =>
        param.id === id ? markEdited({ ...param, ...patch }, original.params.find((o) => o.original !== null && o.original === param.original)) : param,
      ),
    }));
  const moveParam = (id: string, delta: number) =>
    setSignature((current) => {
      const params = [...current.params];
      const index = params.findIndex((param) => param.id === id);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= params.length) return current;
      [params[index], params[target]] = [params[target], params[index]];
      return { ...current, params };
    });
  const removeParam = (id: string) =>
    setSignature((current) => {
      const index = current.params.findIndex((param) => param.id === id);
      const params = current.params.filter((param) => param.id !== id);
      setSelected(params[Math.min(index, params.length - 1)]?.id ?? null);
      return { ...current, params };
    });
  const addParam = () => {
    const taken = new Set(signature.params.map((param) => param.name));
    let name = "param";
    for (let n = 2; taken.has(name); n++) name = `param${n}`;
    const param: SignatureParam = { id: newParamId(), name, type: "", defaultValue: "", value: "", original: null, kind: "positional" };
    // Before *args / **kwargs / ...rest.
    const index = signature.params.findIndex((p) => p.kind === "vararg" || p.kind === "kwarg" || p.kind === "rest");
    setSignature((current) => {
      const params = [...current.params];
      params.splice(index < 0 ? params.length : index, 0, param);
      return { ...current, params };
    });
    setSelected(param.id);
    // Focus its name.
    setTimeout(() => document.querySelector<HTMLInputElement>(`[data-param-name="${param.id}"]`)?.select(), 0);
  };
  const submit = () => {
    if (problem || busy) return;
    void run("Working out the changes…", () => dialog.submit(signature));
  };
  const onRowKey = (event: React.KeyboardEvent, id: string) => {
    if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      moveParam(id, event.key === "ArrowUp" ? -1 : 1);
    }
  };

  return (
    <Frame
      title="Change Signature"
      subtitle={`${original.kind} ${original.name}`}
      badge={dialog.engine.split(",")[0]}
      width={820}
      onSubmit={submit}
      className="rf-change-signature"
      footer={
        <>
          <button type="button" className="rf-button" onClick={close} disabled={!!busy}>
            Cancel
          </button>
          <button type="submit" className="rf-button primary" disabled={!!problem || !!busy || !changed} title={!changed ? "Nothing changed yet" : undefined}>
            Preview…
          </button>
        </>
      }
    >
      <div className="rf-fields">
        <label className="rf-field grow">
          <span>Name</span>
          <input
            ref={nameInput}
            value={signature.name}
            disabled={signature.kind === "constructor"}
            spellCheck={false}
            onChange={(event) => setSignature((current) => ({ ...current, name: event.target.value }))}
          />
        </label>
        {signature.returnType !== null && (
          <label className="rf-field grow">
            <span>Return type</span>
            <input
              value={signature.returnType}
              spellCheck={false}
              placeholder="(none)"
              onChange={(event) => setSignature((current) => ({ ...current, returnType: event.target.value }))}
            />
          </label>
        )}
      </div>
      <div className="rf-section-title">
        <span>Parameters</span>
        <span className="rf-hint">⌥↑ / ⌥↓ reorder</span>
      </div>
      <div className="rf-params" role="table">
        <div className="rf-param-row rf-param-head" role="row" style={columns}>
          <span>Name</span>
          {typed && <span>Type</span>}
          <span>Default value</span>
          <span title="What existing calls pass for a new parameter">Value in calls</span>
          {python && <span>Kind</span>}
          <span />
        </div>
        {signature.implicit && (
          <div className="rf-param-row implicit" role="row" style={columns} title="Passed implicitly; can't be changed here">
            <input value={signature.implicit} disabled />
            {typed && <input disabled />}
            <input disabled />
            <input disabled />
            {python && <span />}
            <span />
          </div>
        )}
        {signature.params.map((param, index) => {
          const isNew = param.original === null;
          const fixedKind = param.kind === "vararg" || param.kind === "kwarg" || param.kind === "rest";
          return (
            <div
              key={param.id}
              className={`rf-param-row${selected === param.id ? " selected" : ""}${isNew ? " added" : ""}`}
              role="row"
              style={columns}
              onFocus={() => setSelected(param.id)}
              onKeyDown={(event) => onRowKey(event, param.id)}
            >
              <span className="rf-param-name">
                {param.kind === "vararg" && <span className="rf-star">*</span>}
                {param.kind === "kwarg" && <span className="rf-star">**</span>}
                {param.kind === "rest" && <span className="rf-star">…</span>}
                <input
                  data-param-name={param.id}
                  aria-label="Parameter name"
                  value={param.name}
                  spellCheck={false}
                  onChange={(event) => update(param.id, { name: event.target.value })}
                />
              </span>
              {typed && (
                <input aria-label="Type" value={param.type} spellCheck={false} onChange={(event) => update(param.id, { type: event.target.value })} />
              )}
              <input
                aria-label="Default value"
                value={param.defaultValue}
                spellCheck={false}
                disabled={fixedKind}
                onChange={(event) => update(param.id, { defaultValue: event.target.value })}
              />
              <input
                aria-label="Value in calls"
                value={param.value}
                spellCheck={false}
                disabled={!isNew || fixedKind}
                placeholder={isNew ? (param.defaultValue ? "(the default)" : "required") : ""}
                onChange={(event) => update(param.id, { value: event.target.value })}
              />
              {python &&
                (fixedKind || param.kind === "posonly" ? (
                  <span className="rf-kind-fixed">{param.kind === "vararg" ? "*args" : param.kind === "kwarg" ? "**kwargs" : KIND_LABELS[param.kind]}</span>
                ) : (
                  <select aria-label="Kind" value={param.kind} onChange={(event) => update(param.id, { kind: event.target.value as SignatureParam["kind"] })}>
                    <option value="positional">positional</option>
                    <option value="kwonly">keyword-only</option>
                  </select>
                ))}
              <span className="rf-row-actions">
                <button type="button" className="rf-icon-button" title="Move up (⌥↑)" disabled={index === 0} onClick={() => moveParam(param.id, -1)}>
                  <ArrowUp size={13} strokeWidth={1.8} />
                </button>
                <button
                  type="button"
                  className="rf-icon-button"
                  title="Move down (⌥↓)"
                  disabled={index === signature.params.length - 1}
                  onClick={() => moveParam(param.id, 1)}
                >
                  <ArrowDown size={13} strokeWidth={1.8} />
                </button>
                <button type="button" className="rf-icon-button danger" title="Remove" onClick={() => removeParam(param.id)}>
                  <X size={13} strokeWidth={1.8} />
                </button>
              </span>
            </div>
          );
        })}
        {signature.params.length === 0 && !signature.implicit && <div className="rf-empty">No parameters</div>}
      </div>
      <button type="button" className="rf-button rf-add" onClick={addParam}>
        <Plus size={13} strokeWidth={1.8} /> Add parameter
      </button>
      <div className="rf-section-title">
        <span>Signature preview</span>
      </div>
      <pre className="rf-signature-preview">{formatSignature(signature)}</pre>
      {dialog.bestEffort && (
        <div className="rf-note">
          <AlertTriangle size={13} strokeWidth={1.8} />
          <span>
            Best effort: calls are found by the language server and rewritten as text, not with a syntax tree. Check the preview.
          </span>
        </div>
      )}
      {problem && <div className="rf-problem">{problem}</div>}
    </Frame>
  );
}

// --- Move -----------------------------------------------------------------------------------------

function MoveDialog({ dialog }: { dialog: Extract<RefactoringDialog, { kind: "move" }> }) {
  const busy = useRefactoringStore((state) => state.busy);
  const folders = useWorkspaceStore((state) => state.folders);
  const [files, setFiles] = useState<string[] | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const directory = parentDirectoryOf(dialog.sourcePath);
  const separator = dialog.sourcePath.includes("\\") && !dialog.sourcePath.includes("/") ? "\\" : "/";

  useEffect(() => {
    let cancelled = false;
    const roots = folders.length > 0 ? folders : [directory];
    void Promise.all(roots.map((root) => listWorkspaceFiles(root).catch(() => [] as string[]))).then((lists) => {
      if (cancelled) return;
      setFiles(
        lists
          .flat()
          .filter((path) => path !== dialog.sourcePath && dialog.extensions.some((extension) => path.endsWith(extension)))
          .filter((path) => !/[/\\](node_modules|\.git|__pycache__|dist|build)[/\\]/.test(path)),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [folders, directory, dialog.sourcePath, dialog.extensions]);

  /** The typed path as a file in the workspace (relative to the source's folder unless rooted). */
  const typedPath = useMemo(() => {
    const text = query.trim();
    if (!text || /[*?"<>|]/.test(text)) return null;
    if (!dialog.extensions.some((extension) => text.endsWith(extension))) return null;
    if (text.startsWith("/") || /^[A-Za-z]:[\\/]/.test(text)) return text;
    const root = folders.find((folder) => text.startsWith(folder.split(/[/\\]/).pop() + "/")) ?? null;
    if (root) return root + separator + text.split("/").slice(1).join(separator);
    return (folders.length === 1 ? folders[0] : directory) + separator + text.replace(/\//g, separator);
  }, [query, folders, directory, separator, dialog.extensions]);

  const items = useMemo(() => {
    const ranked = (files ?? [])
      .map((path) => ({ path, score: fuzzyScore(query.trim(), relative(path)) }))
      .filter((entry): entry is { path: string; score: number } => entry.score !== null)
      .sort((a, b) => b.score - a.score || a.path.length - b.path.length)
      .slice(0, 60)
      .map((entry) => ({ path: entry.path, create: false }));
    const exists = typedPath && (files ?? []).includes(typedPath);
    return typedPath && !exists ? [{ path: typedPath, create: true }, ...ranked] : ranked;
  }, [files, query, typedPath]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(".rf-pick.active")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (path: string | undefined) => {
    if (!path || busy) return;
    void run("Working out the changes…", () => dialog.submit(path));
  };

  return (
    <Frame
      title={`Move ${dialog.what}`}
      subtitle={
        <span className="rf-from">
          from <FileName path={dialog.sourcePath} />
        </span>
      }
      width={640}
      className="rf-move"
      onSubmit={() => choose(items[active]?.path)}
      footer={
        <>
          <button type="button" className="rf-button" onClick={close} disabled={!!busy}>
            Cancel
          </button>
          <button type="submit" className="rf-button primary" disabled={!items[active] || !!busy}>
            Preview…
          </button>
        </>
      }
    >
      <label className="rf-field">
        <span>To file — pick one, or type a new file's path ({dialog.extensions[0]})</span>
        <input
          autoFocus
          value={query}
          spellCheck={false}
          placeholder={`e.g. ${relative(directory + separator + "helpers" + dialog.extensions[0])}`}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((index) => Math.min(index + 1, items.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((index) => Math.max(index - 1, 0));
            }
          }}
        />
      </label>
      <div className="rf-picker" ref={listRef} role="listbox">
        {files === null && <div className="rf-empty">Listing files…</div>}
        {files !== null && items.length === 0 && <div className="rf-empty">No matching files — type a new file's path to create it</div>}
        {items.map((item, index) => (
          <button
            type="button"
            key={`${item.create}:${item.path}`}
            role="option"
            aria-selected={index === active}
            className={`rf-pick${index === active ? " active" : ""}`}
            onMouseEnter={() => setActive(index)}
            onClick={() => choose(item.path)}
          >
            {item.create ? (
              <span className="rf-file-name">
                <FilePlus2 size={13} strokeWidth={1.6} className="rf-file-icon create" />
                <span className="rf-file-base">Create {relative(item.path)}</span>
              </span>
            ) : (
              <FileName path={item.path} />
            )}
          </button>
        ))}
      </div>
    </Frame>
  );
}

// --- Refactoring Preview ---------------------------------------------------------------------------

function fileStatus(file: PlannedFile, moves: RefactoringPlan["moves"]): { label: string; className: string } {
  if (file.before === null) return { label: "new", className: "added" };
  if (file.after === null) return { label: "deleted", className: "deleted" };
  if (moves.some((move) => move.from === file.path)) return { label: "moved", className: "moved" };
  return { label: "changed", className: "changed" };
}

function FileDiff({ file }: { file: PlannedFile }) {
  const parts = useMemo(() => hunks(file.before ?? "", file.after ?? "", 2), [file]);
  if (file.after === null) {
    return <div className="rf-diff-note">The file is deleted ({(file.before ?? "").split("\n").length} lines).</div>;
  }
  if (file.before === null) {
    if (file.after === "") return <div className="rf-diff-note">A new, empty file.</div>;
    return (
      <div className="rf-diff">
        {file.after
          .replace(/\n$/, "")
          .split("\n")
          .map((text, index) => (
            <div key={index} className="rf-diff-line added">
              <span className="rf-diff-number">{index + 1}</span>
              <span className="rf-diff-sign">+</span>
              <span className="rf-diff-text">{text || " "}</span>
            </div>
          ))}
      </div>
    );
  }
  return (
    <div className="rf-diff">
      {parts.map((hunk, index) => (
        <div key={index} className="rf-hunk">
          <div className="rf-hunk-header">line {hunk.newStart}</div>
          {hunk.lines.map((line, lineIndex) => (
            <div key={lineIndex} className={`rf-diff-line ${line.kind}`}>
              <span className="rf-diff-number">{line.kind === "added" ? line.newLine : line.oldLine}</span>
              <span className="rf-diff-sign">{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}</span>
              <span className="rf-diff-text">{line.text || " "}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function PreviewDialog({ dialog }: { dialog: Extract<RefactoringDialog, { kind: "preview" }> }) {
  const busy = useRefactoringStore((state) => state.busy);
  const { plan } = dialog;
  const files = plan.files.filter((file) => file.before !== file.after);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(files.length > 6 ? files.slice(3).map((file) => file.path) : []));
  const totals = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const file of files) {
      const counts = countChanges(file.before ?? "", file.after ?? "");
      added += counts.added;
      removed += counts.removed;
    }
    return { added, removed };
  }, [files]);
  const toggle = (path: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const count = new Set([...files.map((file) => file.path), ...plan.moves.map((move) => move.from)]).size;

  return (
    <Frame
      title="Refactoring Preview"
      subtitle={
        <>
          {plan.title} — {count} file{count === 1 ? "" : "s"}
          <span className="rf-totals">
            <span className="added">+{totals.added}</span> <span className="removed">−{totals.removed}</span>
          </span>
        </>
      }
      badge={plan.engine.split(",")[0]}
      width={900}
      className="rf-preview"
      onSubmit={() => void run("Applying…", dialog.apply)}
      footer={
        <>
          <button type="button" className="rf-button" onClick={close} disabled={!!busy}>
            Cancel
          </button>
          {dialog.alternative && (
            <button type="button" className="rf-button" disabled={!!busy} onClick={() => void run("Applying…", dialog.alternative!.run)}>
              {dialog.alternative.label}
            </button>
          )}
          <button type="submit" className={`rf-button ${plan.conflicts.length > 0 ? "danger" : "primary"}`} autoFocus disabled={!!busy}>
            {dialog.applyLabel ?? (plan.conflicts.length > 0 ? "Refactor Anyway" : "Do Refactor")}
          </button>
        </>
      }
    >
      {plan.conflicts.length > 0 && (
        <div className="rf-conflicts">
          <div className="rf-conflicts-title">
            <AlertTriangle size={13} strokeWidth={1.8} /> {plan.conflicts.length} problem{plan.conflicts.length === 1 ? "" : "s"} found
          </div>
          <ul>
            {plan.conflicts.map((conflict, index) => (
              <li key={index}>{conflict}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="rf-files">
        {plan.moves.map((move) => (
          <div key={`move:${move.from}`} className="rf-move-row">
            <FileName path={move.from} />
            <ArrowRight size={13} strokeWidth={1.8} className="rf-move-arrow" />
            <FileName path={move.to} />
            <span className="rf-status moved">{parentDirectoryOf(move.from) === parentDirectoryOf(move.to) ? "renamed" : "moved"}</span>
          </div>
        ))}
        {files.map((file) => {
          const status = fileStatus(file, plan.moves);
          const open = !collapsed.has(file.path);
          const counts = countChanges(file.before ?? "", file.after ?? "");
          const Chevron = open ? ChevronDown : ChevronRight;
          return (
            <div key={file.path} className="rf-file">
              <button type="button" className="rf-file-header" onClick={() => toggle(file.path)} aria-expanded={open}>
                <Chevron size={13} strokeWidth={1.6} className="rf-chevron" />
                <FileName path={file.path} />
                <span className={`rf-status ${status.className}`}>{status.label}</span>
                <span className="rf-totals">
                  {counts.added > 0 && <span className="added">+{counts.added}</span>}
                  {counts.removed > 0 && <span className="removed">−{counts.removed}</span>}
                </span>
              </button>
              {open && <FileDiff file={file} />}
            </div>
          );
        })}
      </div>
    </Frame>
  );
}
