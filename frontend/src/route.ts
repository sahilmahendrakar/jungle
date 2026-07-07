import { useEffect, useState } from "react";

export function currentPath(): string {
  const p = location.pathname.replace(/\/+$/, "");
  return p || "/";
}

export function navigate(path: string) {
  // Preserve the query string across in-app navigation — the dev identity (?as=) lives there.
  history.pushState({}, "", path + location.search);
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
