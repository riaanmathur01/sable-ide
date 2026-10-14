import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Pencil } from "lucide-react";
import { github, type Label } from "../../lib/github/api";
import { act } from "../../store/githubStore";
import { Avatar, LabelChip } from "./common";

/** Labels and assignable users, per repository (fetched once). */
const labelCache = new Map<string, Promise<Label[]>>();
const assigneeCache = new Map<string, Promise<string[]>>();

export function repoLabels(root: string): Promise<Label[]> {
  if (!labelCache.has(root)) labelCache.set(root, github.labels(root).catch((error) => (labelCache.delete(root), Promise.reject(error))));
  return labelCache.get(root)!;
}

export function repoAssignees(root: string): Promise<string[]> {
  if (!assigneeCache.has(root)) assigneeCache.set(root, github.assignees(root).catch((error) => (assigneeCache.delete(root), Promise.reject(error))));
  return assigneeCache.get(root)!;
}

/**
 * A sidebar block (Labels, Assignees, Reviewers…) whose ✎ opens a checklist
 * to choose from; closing it applies the difference.
 */
export function ChoiceBlock({
  title,
  selected,
  load,
  render,
  onApply,
  empty,
  testId,
}: {
  title: string;
  selected: string[];
  load: () => Promise<{ value: string; label?: Label }[]>;
  render: (values: string[]) => React.ReactNode;
  onApply?: (add: string[], remove: string[]) => Promise<unknown>;
  empty: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<{ value: string; label?: Label }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string[]>(selected);
  const [filter, setFilter] = useState("");
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setChosen(selected);
    setFilter("");
    load().then(setOptions, (failure) => setError(String(failure)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const close = async () => {
    setOpen(false);
    const add = chosen.filter((value) => !selected.includes(value));
    const remove = selected.filter((value) => !chosen.includes(value));
    if ((add.length || remove.length) && onApply) await act(() => onApply(add, remove));
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) void close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") void close();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  });

  const shown = useMemo(
    () => (options ?? []).filter((option) => option.value.toLowerCase().includes(filter.toLowerCase())),
    [options, filter],
  );

  return (
    <div className="gh-side-block" ref={box} data-block={testId}>
      <div className="gh-side-title">
        {title}
        {onApply && (
          <button className="gh-link-button" title={`Edit ${title.toLowerCase()}`} onClick={() => (open ? void close() : setOpen(true))}>
            <Pencil size={11} strokeWidth={1.75} />
          </button>
        )}
      </div>
      {selected.length ? render(selected) : <div className="gh-muted gh-side-empty">{empty}</div>}
      {open && (
        <div className="gh-popover">
          <input className="gh-input" placeholder="Filter" value={filter} autoFocus onChange={(event) => setFilter(event.target.value)} />
          <div className="gh-popover-list">
            {error ? (
              <div className="gh-error-text">{error}</div>
            ) : !options ? (
              <div className="gh-muted gh-popover-empty">Loading…</div>
            ) : shown.length === 0 ? (
              <div className="gh-muted gh-popover-empty">Nothing matches</div>
            ) : (
              shown.map((option) => {
                const on = chosen.includes(option.value);
                return (
                  <div
                    key={option.value}
                    className={`gh-popover-item${on ? " on" : ""}`}
                    onClick={() => setChosen((current) => (on ? current.filter((value) => value !== option.value) : [...current, option.value]))}
                  >
                    <span className="gh-popover-check">{on && <Check size={12} strokeWidth={2} />}</span>
                    {option.label ? <LabelChip label={option.label} /> : (
                      <>
                        <Avatar login={option.value} size={16} />
                        <span>{option.value}</span>
                      </>
                    )}
                  </div>
                );
              })
            )}
          </div>
          <div className="gh-popover-footer">
            <button className="gh-button primary" onClick={() => void close()}>
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function LabelList({ labels }: { labels: Label[] }) {
  return (
    <div className="gh-label-list">
      {labels.map((label) => (
        <LabelChip key={label.name} label={label} />
      ))}
    </div>
  );
}

export function PeopleList({ people, states }: { people: string[]; states?: Record<string, string> }) {
  return (
    <div className="gh-people">
      {people.map((login) => (
        <div key={login} className="gh-person">
          <Avatar login={login} size={18} />
          <span>{login}</span>
          {states?.[login] && <ReviewerState state={states[login]} />}
        </div>
      ))}
    </div>
  );
}

const REVIEW_STATES: Record<string, { text: string; className: string }> = {
  APPROVED: { text: "Approved", className: "approved" },
  CHANGES_REQUESTED: { text: "Changes requested", className: "changes" },
  COMMENTED: { text: "Commented", className: "commented" },
  REQUESTED: { text: "Requested", className: "requested" },
  DISMISSED: { text: "Dismissed", className: "commented" },
};

export function ReviewerState({ state }: { state: string }) {
  const known = REVIEW_STATES[state] ?? { text: state.toLowerCase(), className: "commented" };
  return <span className={`gh-review-state ${known.className}`}>{known.text}</span>;
}
