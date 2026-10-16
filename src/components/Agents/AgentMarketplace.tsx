import { Settings } from "lucide-react";
import type { RegistryEntry } from "../../lib/acp/ipc";
import { agentName, profileFor } from "../../lib/acp/agents";
import { useTabsStore } from "../../store/tabsStore";
import { AgentIcon } from "./AgentIcon";
import { InstallButton } from "./AgentsSettings";
import "./Agents.css";

/**
 * Plugins → Marketplace → "AI Agents": coding agents, installable like
 * extensions (from the ACP registry). Installing here is the same as in
 * Settings → AI Agents, where sign-in is set up.
 */
export function AgentMarketplace({ agents, more }: { agents: RegistryEntry[]; more?: () => void }) {
  return (
    <div className="agent-marketplace">
      <div className="agent-marketplace-heading">
        <span>AI Agents</span>
        <span className="acp-muted">Coding agents that work in your workspace — sign in with your account, an API key or a cloud provider.</span>
        {more && (
          <button className="acp-link" onClick={more}>
            See all agents
          </button>
        )}
      </div>
      <div className="marketplace-grid">
        {agents.map((entry) => {
          const profile = profileFor(entry.id);
          return (
            <div key={entry.id} className="marketplace-card agent-market-card" data-agent={entry.id}>
              <div className="marketplace-card-title agent-market-title">
                <AgentIcon id={entry.id} size={18} iconUrl={entry.icon} />
                <span className="marketplace-card-name">{agentName(entry.id, entry.name)}</span>
                <span className="plugin-version">{entry.version}</span>
                {profile && !profile.integrated && <span className="acp-tag warn">Preview</span>}
              </div>
              <div className="marketplace-card-author">by {profile?.vendor && entry.id !== "claude-acp" ? profile.vendor : (entry.authors.join(", ") || "—")}</div>
              <p className="marketplace-card-description">{profile?.description ?? entry.description}</p>
              <div className="agent-market-actions">
                <span className="marketplace-tag">AI agent</span>
                <span className="marketplace-tag">{entry.distribution.npx ? "npm" : entry.distribution.binary ? "native" : "python"}</span>
                <span className="acp-composer-spacer" />
                <button className="acp-icon-button" title="Sign-in and settings" onClick={() => useTabsStore.getState().openSettings("agents")}>
                  <Settings size={13} />
                </button>
                <InstallButton entry={entry} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
