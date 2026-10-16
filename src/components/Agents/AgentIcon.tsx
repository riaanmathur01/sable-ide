import { useEffect, useState } from "react";
import { Bot, Sparkles } from "lucide-react";
import { profileFor, SABLE_AGENT_ID } from "../../lib/acp/agents";
import { useAgentHubStore } from "../../store/agentHubStore";

/** Whether an icon URL loads (checked once per URL). */
const iconLoads = new Map<string, Promise<boolean>>();
function useLoads(url: string | null | undefined): boolean | null {
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => {
    if (!url) return;
    let alive = true;
    let check = iconLoads.get(url);
    if (!check) {
      check = new Promise<boolean>((resolve) => {
        const image = new Image();
        image.onload = () => resolve(true);
        image.onerror = () => resolve(false);
        image.src = url;
      });
      iconLoads.set(url, check);
    }
    void check.then((result) => alive && setOk(result));
    return () => {
      alive = false;
    };
  }, [url]);
  return url ? ok : false;
}

/**
 * An agent's mark: Sable's own glyphs for Sable's agent and the Claude
 * entries (no vendor marks), the icon the ACP registry publishes for
 * clients (a monochrome SVG, as a mask so it takes the text color) for the
 * rest — Codex, Cursor and Kimi Code included — else a neutral letter
 * tile (offline) or a generic robot.
 */
export function AgentIcon({ id, size = 16, iconUrl, className }: { id: string; size?: number; iconUrl?: string | null; className?: string }) {
  const color = profileFor(id)?.color;
  const registryIcon = useAgentHubStore((state) => (iconUrl ? null : state.registry?.agents.find((agent) => agent.id === id)?.icon));
  const url = iconUrl ?? registryIcon;
  const loads = useLoads(url);
  const style = { width: size, height: size, flexShrink: 0 } as const;
  const classes = `agent-icon${className ? ` ${className}` : ""}`;
  switch (id) {
    case SABLE_AGENT_ID:
      return (
        <span className={`${classes} agent-icon-sable`} style={style}>
          <Sparkles size={Math.round(size * 0.82)} strokeWidth={1.75} />
        </span>
      );
    case "claude-acp":
      // A neutral agent glyph (no vendor marks): a spark in a rounded tile.
      return (
        <svg className={classes} style={style} viewBox="0 0 24 24" aria-hidden="true">
          <rect x={2.5} y={2.5} width={19} height={19} rx={5.5} fill="none" stroke={color} strokeWidth={1.8} />
          <path d="M12 6.8l1.35 3.85L17.2 12l-3.85 1.35L12 17.2l-1.35-3.85L6.8 12l3.85-1.35z" fill={color} />
        </svg>
      );
    case "claude-code":
      // A neutral prompt glyph (no vendor marks).
      return (
        <svg className={classes} style={style} viewBox="0 0 24 24" aria-hidden="true">
          <rect x={2.5} y={3.5} width={19} height={17} rx={4} fill="none" stroke="currentColor" strokeWidth={1.8} />
          <path d="M7 9.5l3 2.5-3 2.5M12 15h5" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    default:
      if (url && loads !== false) {
        return (
          <span
            className={`${classes} agent-icon-mask`}
            style={{ ...style, WebkitMaskImage: `url("${url}")`, maskImage: `url("${url}")` }}
            aria-hidden="true"
          />
        );
      }
      if (profileFor(id)) {
        const letter = (profileFor(id)?.name ?? id)[0].toUpperCase();
        return (
          <svg className={classes} style={style} viewBox="0 0 24 24" aria-hidden="true">
            <rect x={2.5} y={2.5} width={19} height={19} rx={5.5} fill="none" stroke={color ?? "currentColor"} strokeWidth={1.8} />
            <text x={12} y={16.2} textAnchor="middle" fontSize={11} fontWeight={700} fontFamily="var(--font-ui)" fill={color ?? "currentColor"}>
              {letter}
            </text>
          </svg>
        );
      }
      return (
        <span className={classes} style={style}>
          <Bot size={Math.round(size * 0.9)} strokeWidth={1.6} />
        </span>
      );
  }
}
