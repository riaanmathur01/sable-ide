import { lazy, type ComponentType } from "react";

/**
 * A lazily loaded component that can be loaded ahead of time — and, once
 * loaded, renders directly instead of through Suspense. That matters:
 * React holds back revealing a suspended boundary for ~300 ms (to avoid
 * flicker), so every first render of a plain `lazy()` view cost the user
 * 300 ms even when its code was already downloaded.
 */
export function preloadable<P extends object>(load: () => Promise<{ default: ComponentType<P> }>) {
  let loaded: ComponentType<P> | null = null;
  let loading: Promise<ComponentType<P>> | null = null;
  const preload = () =>
    (loading ??= load().then((module) => {
      loaded = module.default;
      return loaded;
    }));
  const Lazy = lazy(() => preload().then((component) => ({ default: component })));
  function Component(props: P) {
    const Ready = loaded;
    return Ready ? <Ready {...props} /> : <Lazy {...props} />;
  }
  return Object.assign(Component, { preload });
}
