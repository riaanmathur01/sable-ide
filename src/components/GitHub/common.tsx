import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, CircleDot, Dot, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, X } from "lucide-react";
import type { CheckState, Label } from "../../lib/github/api";
import { useUiStore } from "../../store/uiStore";

/** Avatars that failed to load (bots, offline): shown as an initial. */
const failedAvatars = new Set<string>();

/** Where a login's avatar is (the browser caches it). */
export function avatarUrl(login: string, size = 40): string {
  return `https://avatars.githubusercontent.com/${encodeURIComponent(login.replace(/\[bot\]$/, ""))}?s=${size * 2}`;
}

export function Avatar({ login, size = 16 }: { login: string; size?: number }) {
  const [failed, setFailed] = useState(failedAvatars.has(login));
  const style = { width: size, height: size, flexBasis: size };
  if (failed || !login) {
    return (
      <span className="gh-avatar gh-avatar-initial" style={{ ...style, fontSize: Math.round(size * 0.55) }} title={login}>
        {(login || "?").charAt(0).toUpperCase()}
      </span>
    );
  }
  return (
    <img
      className="gh-avatar"
      style={style}
      src={avatarUrl(login, size)}
      alt=""
      title={login}
      loading="lazy"
      draggable={false}
      onError={() => {
        failedAvatars.add(login);
        setFailed(true);
      }}
    />
  );
}

/** A label in its GitHub color, readable in light and dark themes. */
export function LabelChip({ label }: { label: Label }) {
  const color = `#${(label.color || "8b949e").replace(/^#/, "")}`;
  return (
    <span
      className="gh-label"
      title={label.name}
      style={{
        color: `color-mix(in srgb, ${color} 40%, var(--text))`,
        background: `color-mix(in srgb, ${color} 18%, transparent)`,
        borderColor: `color-mix(in srgb, ${color} 50%, transparent)`,
      }}
    >
      {label.name}
    </span>
  );
}

/** ✓ / ✗ / ● for a pull request's checks. */
export function CheckBadge({ state, size = 13 }: { state: CheckState | string; size?: number }) {
  if (state === "success" || state === "neutral" || state === "skipped")
    return <Check className="gh-check success" size={size} strokeWidth={2.25} aria-label="Checks passed" />;
  if (state === "failure") return <X className="gh-check failure" size={size} strokeWidth={2.25} aria-label="Checks failed" />;
  if (state === "pending") return <Dot className="gh-check pending" size={size + 6} strokeWidth={6} aria-label="Checks running" />;
  return null;
}

const CHECK_TITLES: Record<string, string> = {
  success: "All checks passed",
  failure: "Some checks failed",
  pending: "Checks are running",
};

export function checkTitle(state: string): string {
  return CHECK_TITLES[state] ?? "No checks";
}

/** The review decision, as GitHub words it. */
export function reviewDecisionText(decision: string): string | null {
  switch (decision) {
    case "APPROVED":
      return "Approved";
    case "CHANGES_REQUESTED":
      return "Changes requested";
    case "REVIEW_REQUIRED":
      return "Review required";
    default:
      return null;
  }
}

/** A pull request's icon for its state. */
export function PrStateIcon({ state, isDraft, size = 14 }: { state: string; isDraft: boolean; size?: number }) {
  if (state === "MERGED") return <GitMerge className="gh-state merged" size={size} strokeWidth={1.75} />;
  if (state === "CLOSED") return <GitPullRequestClosed className="gh-state closed" size={size} strokeWidth={1.75} />;
  if (isDraft) return <GitPullRequestDraft className="gh-state draft" size={size} strokeWidth={1.75} />;
  return <GitPullRequest className="gh-state open" size={size} strokeWidth={1.75} />;
}

export function IssueStateIcon({ state, size = 14 }: { state: string; size?: number }) {
  return <CircleDot className={`gh-state ${state === "CLOSED" ? "closed-issue" : "open"}`} size={size} strokeWidth={1.75} />;
}

/** The state pill (Open / Draft / Merged / Closed). */
export function StatePill({ state, isDraft, issue }: { state: string; isDraft?: boolean; issue?: boolean }) {
  const kind = state === "MERGED" ? "merged" : state === "CLOSED" ? (issue ? "closed-issue" : "closed") : isDraft ? "draft" : "open";
  const text = state === "MERGED" ? "Merged" : state === "CLOSED" ? "Closed" : isDraft ? "Draft" : "Open";
  return (
    <span className={`gh-pill ${kind}`}>
      {issue ? <IssueStateIcon state={state} size={13} /> : <PrStateIcon state={state} isDraft={!!isDraft} size={13} />}
      {text}
    </span>
  );
}

export function openExternal(url: string): void {
  if (!url) return;
  void openUrl(url).catch((error) => useUiStore.getState().setLastError(String(error)));
}
