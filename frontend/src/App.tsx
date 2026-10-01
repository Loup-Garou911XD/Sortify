import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type {
  JobView,
  PlaylistSummary,
  RunSummary,
  StatusResponse,
} from "../../backend/src/api/types.ts";
import { api } from "./api.ts";
import { Home } from "./components/Home.tsx";
import { JobBar } from "./components/JobBar.tsx";
import { PlaylistPage } from "./components/PlaylistPage.tsx";
import { RunPage } from "./components/RunPage.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { SignInDialog } from "./components/SignInDialog.tsx";
import { Toasts } from "./components/Toasts.tsx";
import { TopBar } from "./components/TopBar.tsx";
import { Notice } from "./components/ui.tsx";
import { type Theme, useInterval, useLocation, useResource, useTheme } from "./hooks.ts";

export type Tone = "good" | "error";
export interface Toast {
  id: number;
  tone: Tone;
  text: string;
}

export interface AppState {
  status: StatusResponse | undefined;
  playlists: PlaylistSummary[];
  runs: RunSummary[];
  job: JobView | null;
  /** Bumped whenever a background task finishes, so open pages refetch. */
  version: number;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  navigate: (to: string) => void;
  refresh: () => void;
  /** POSTs an action that starts a background task and begins tracking it. */
  startJob: (path: string, body?: unknown) => Promise<void>;
  openSignIn: () => void;
  notify: (tone: Tone, text: string) => void;
  /**
   * Set only by shells that keep their own keys — the static build, where there is no `.env`.
   * When present the Connections panel turns each row into a button and hands back the id of
   * the source to configure ("account" for the Google client itself). Unset in the local app,
   * where keys come from the environment and the rows stay plain text.
   */
  configureSource?: (id: string) => void;
}

const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp outside <App>");
  return ctx;
}

let toastId = 0;

export function App({ configureSource }: { configureSource?: (id: string) => void } = {}) {
  const [path, navigate] = useLocation();
  const [version, setVersion] = useState(0);
  const status = useResource<StatusResponse>("/api/status", version);
  const playlists = useResource<PlaylistSummary[]>("/api/playlists", version);
  const runs = useResource<RunSummary[]>("/api/runs", version);
  const [job, setJob] = useState<JobView | null>(null);
  const [signInOpen, setSignInOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [theme, setTheme] = useTheme();
  const lastJobStatus = useRef<string | null>(null);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const notify = useCallback(
    (tone: Tone, text: string) => {
      const id = ++toastId;
      setToasts((list) => [...list, { id, tone, text }]);
      // Successes announce themselves and leave; errors wait to be read.
      if (tone === "good") setTimeout(() => dismiss(id), 5000);
    },
    [dismiss],
  );

  const pollJob = useCallback(async () => {
    const current = await api<JobView | null>("/api/job").catch(() => null);
    setJob(current);
    // Refresh everything once when a task finishes.
    if (lastJobStatus.current === "running" && current?.status !== "running") refresh();
    lastJobStatus.current = current?.status ?? null;
  }, [refresh]);

  useEffect(() => {
    void pollJob();
  }, [pollJob]);
  useInterval(() => void pollJob(), 800, job?.status === "running");
  // Keep progress numbers in the sidebar moving while a task runs.
  useInterval(refresh, 4000, job?.status === "running");

  // A sync can bring in work from another device while this page sits open. Poll for that
  // narrowly and refresh only when something actually arrived: a blanket refresh would rebuild
  // the sort preview and throw away a half-edited plan.
  // Only a merge that brought something in is recorded, so the first one seen after this page
  // loaded still triggers a refresh even if it landed before the first status read.
  const mergedAt = useRef<string | null>(null);
  const checkSync = useCallback(async () => {
    const current = await api<StatusResponse>("/api/status").catch(() => null);
    if (!current?.sync?.changed || current.sync.at === mergedAt.current) return;
    mergedAt.current = current.sync.at;
    refresh();
  }, [refresh]);
  useEffect(() => {
    void checkSync();
  }, [checkSync]);
  useInterval(
    () => void checkSync(),
    5000,
    Boolean(status.data?.sync) && job?.status !== "running",
  );

  // Close the mobile drawer whenever the route changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the route is the trigger
  useEffect(() => setDrawerOpen(false), [path]);

  // Messages from the Google sign-in redirect.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has("signedIn")) notify("good", "YouTube is connected.");
    const authError = params.get("authError");
    if (authError) notify("error", authError);
    if (params.size > 0) window.history.replaceState(null, "", window.location.pathname);
  }, [notify]);

  const startJob = useCallback(async (jobPath: string, body: unknown = {}) => {
    const started = await api<JobView>(jobPath, { method: "POST", body });
    lastJobStatus.current = "running";
    setJob(started);
  }, []);

  const state: AppState = {
    status: status.data,
    playlists: playlists.data ?? [],
    runs: runs.data ?? [],
    job,
    version,
    theme,
    setTheme,
    navigate,
    refresh,
    startJob,
    openSignIn: () => setSignInOpen(true),
    notify,
    configureSource,
  };

  const playlistMatch = /^\/playlists\/([\w-]+)$/.exec(path);
  const runMatch = /^\/runs\/(\d+)$/.exec(path);

  return (
    <AppContext.Provider value={state}>
      <div className="app">
        <TopBar drawerOpen={drawerOpen} onToggleDrawer={() => setDrawerOpen((v) => !v)} />
        <div className="layout">
          <Sidebar path={path} open={drawerOpen} />
          {drawerOpen && (
            <button
              type="button"
              className="scrim"
              aria-label="Close the menu"
              onClick={() => setDrawerOpen(false)}
            />
          )}
          <main className="main" id="main">
            {status.error ? (
              <div className="page page-narrow">
                <Notice tone="error">
                  <strong>Cannot reach the Sortify server.</strong>
                  <div>{status.error}</div>
                  <div>
                    Start it with <code>sortify ui</code>, then reload this page.
                  </div>
                </Notice>
              </div>
            ) : playlistMatch?.[1] ? (
              <PlaylistPage key={playlistMatch[1]} playlistId={playlistMatch[1]} />
            ) : runMatch?.[1] ? (
              <RunPage key={runMatch[1]} runId={Number(runMatch[1])} />
            ) : (
              <Home />
            )}
          </main>
        </div>
        <JobBar />
        <Toasts toasts={toasts} onDismiss={dismiss} />
        {signInOpen && (
          <SignInDialog
            onClose={() => setSignInOpen(false)}
            onSignedIn={() => {
              setSignInOpen(false);
              notify("good", "YouTube is connected.");
              refresh();
            }}
          />
        )}
      </div>
    </AppContext.Provider>
  );
}
