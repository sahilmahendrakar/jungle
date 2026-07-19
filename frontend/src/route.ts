import { useEffect, useState } from "react";

export function currentPath(): string {
  const p = location.pathname.replace(/\/+$/, "");
  return p || "/";
}

// Params that survive every in-app navigation even on a reset — the dev identity (?as=) is how
// you're signed in locally, so it can never be dropped.
const CARRY_OVER = ["as"];

export function navigate(path: string, opts: { resetQuery?: boolean } = {}) {
  // Preserve the query string across in-app navigation (the dev identity lives there). A target
  // may carry its own params (/activity?type=deliverables): current params it doesn't set are
  // merged in; resetQuery drops everything except CARRY_OVER (used to clear a page's filters).
  const [pathname, targetQs] = path.split("?");
  const sp = new URLSearchParams(targetQs ?? "");
  const cur = new URLSearchParams(location.search);
  if (opts.resetQuery) {
    for (const k of CARRY_OVER) {
      const v = cur.get(k);
      if (v && !sp.has(k)) sp.set(k, v);
    }
  } else {
    for (const [k, v] of cur) if (!sp.has(k)) sp.set(k, v);
  }
  const s = sp.toString();
  history.pushState({}, "", s ? `${pathname}?${s}` : pathname);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function usePath(): string {
  const [path, setPath] = useState(currentPath);
  useEffect(() => {
    const sync = () => setPath(currentPath());
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  return path;
}
