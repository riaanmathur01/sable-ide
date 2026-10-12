import { PluginWebviewFrame } from "./PluginWebviewFrame";

/** A plugin's webview panel, as an editor tab. */
export default function PluginWebviewTab({ id }: { id: string }) {
  return <PluginWebviewFrame id={id} />;
}
