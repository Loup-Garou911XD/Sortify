import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.ts";

export interface Resource<T> {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
  reload: () => void;
}

/** GETs `path` and refetches whenever `path` or `version` changes. `null` skips the request. */
export function useResource<T>(path: string | null, version = 0): Resource<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: version and tick are refetch triggers
  useEffect(() => {
    if (path === null) {
      setData(undefined);
      return;
    }
    let live = true;
    setLoading(true);
    api<T>(path)
      .then((d) => {
        if (!live) return;
        setData(d);
        setError(undefined);
      })
      .catch((e: Error) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [path, version, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

/**
 * Where the app is served from: "" for the local server, "/Sortify" for a project page on
 * GitHub Pages. Routes are written without it, so it is stripped on the way in and added back
 * on the way out.
 */
const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const appPath = (pathname: string): string =>
  BASE && pathname.startsWith(BASE) ? pathname.slice(BASE.length) || "/" : pathname;

/** Pathname-based routing without a router dependency. */
export function useLocation(): [string, (to: string) => void] {
  const [path, setPath] = useState(() => appPath(window.location.pathname));
  useEffect(() => {
    const onPop = () => setPath(appPath(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = useCallback((to: string) => {
    if (to === appPath(window.location.pathname)) return;
    window.history.pushState(null, "", BASE + to);
    setPath(to);
    // The main column is the scroll container, not the window.
    document.getElementById("main")?.scrollTo(0, 0);
  }, []);
  return [path, navigate];
}

export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

export type Theme = "light" | "dark" | "system";
const THEME_KEY = "sortify-theme";

const readTheme = (): Theme => {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
};

/**
 * Light, dark, or whatever the system says. "system" removes the attribute so the stylesheet's
 * `light-dark()` tokens follow `prefers-color-scheme` again.
 */
export function useTheme(): [Theme, (next: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(readTheme);

  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    try {
      if (theme === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Private browsing: the choice just does not survive a reload.
    }
  }, [theme]);

  return [theme, setTheme];
}

/** Runs `fn` every `ms` while `active`; the latest `fn` is always used. */
export function useInterval(fn: () => void, ms: number, active: boolean): void {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => saved.current(), ms);
    return () => clearInterval(id);
  }, [ms, active]);
}

const numberFormat = new Intl.NumberFormat();
export const fmt = (n: number): string => numberFormat.format(n);

export const plural = (n: number, one: string, many = `${one}s`): string =>
  `${fmt(n)} ${n === 1 ? one : many}`;

export const DIMENSION_NOUN = { subgenre: "subgenre", mood: "mood", type: "song type" } as const;

/** A plan's name wherever it is shown: "3 playlists by subgenre". */
export const planName = (run: {
  groupCount: number;
  dimension: keyof typeof DIMENSION_NOUN;
}): string => `${plural(run.groupCount, "playlist")} by ${DIMENSION_NOUN[run.dimension]}`;

export const pct = (part: number, whole: number): number =>
  whole === 0 ? 0 : Math.round((100 * part) / whole);

export function duration(seconds: number | null): string {
  if (seconds === null) return "";
  const m = Math.floor(seconds / 60);
  const s = String(seconds % 60).padStart(2, "0");
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

export function timeAgo(iso: string): string {
  const diff = (Date.now() - Date.parse(iso)) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86_400) return `${Math.floor(diff / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** YouTube write cost: 50 units per playlist created and per track added. */
export function quotaFor(playlists: number, additions: number, dailyQuota: number) {
  const units = (playlists + additions) * 50;
  return { units, days: Math.ceil(units / dailyQuota) };
}
