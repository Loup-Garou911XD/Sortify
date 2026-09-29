import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type {
  JobView,
  PlaylistSummary,
  RunSummary,
  StatusResponse,
} from "../../backend/src/api/types.ts";
import { api } from "./api.ts";
import { JobBar } from "./components/JobBar.tsx";
import { PlaylistPage } from "./components/PlaylistPage.tsx";
import { RunPage } from "./components/RunPage.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { SignInDialog } from "./components/SignInDialog.tsx";
import { TopBar } from "./components/TopBar.tsx";
import { Notice } from "./components/ui.tsx";
import { Welcome } from "./components/Welcome.tsx";
import { useInterval, useLocation, useResource } from "./hooks.ts";

export interface AppState {
  status: StatusResponse | undefined;
  playlists: PlaylistSummary[];
  runs: RunSummary[];
  job: JobView | null;
  /** Bumped whenever a background task finishes, so open pages refetch. */
  version: number;
  navigate: (to: string) => void;
  refresh: () => void;
  /** POSTs an action that starts a background task and begins tracking it. */
  startJob: (path: string, body?: unknown) => Promise<void>;
  openSignIn: () => void;
}

const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp outside <App>");
  return ctx;
}

export function App() {
  const [path, navigate] = useLocation();
  const [version, setVersion] = useState(0);
  const status = useResource<StatusResponse>("/api/status", version);
  const playlists = useResource<PlaylistSummary[]>("/api/playlists", version);
  const runs = useResource<RunSummary[]>("/api/runs", version);
  const [job, setJob] = useState<JobView | null>(null);
  const [signInOpen, setSignInOpen] = useState(false);
  const [banner, setBanner] = useState<{ tone: "good" | "error"; text: string } | null>(null);
  const lastJobStatus = useRef<string | null>(null);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);

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

  // Messages from the Google sign-in redirect.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has("signedIn")) setBanner({ tone: "good", text: "YouTube is connected." });
    const authError = params.get("authError");
    if (authError) setBanner({ tone: "error", text: authError });
    if (params.size > 0) window.history.replaceState(null, "", window.location.pathname);
  }, []);

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
    navigate,
    refresh,
    startJob,
    openSignIn: () => setSignInOpen(true),
  };

  const playlistMatch = /^\/playlists\/([\w-]+)$/.exec(path);
  const runMatch = /^\/runs\/(\d+)$/.exec(path);

  return (
    <AppContext.Provider value={state}>
      <div className="app">
        <TopBar />
        <div className="layout">
          <Sidebar path={path} />
          <main className="main">
            {banner && (
              <div className="banner-slot">
                <Notice tone={banner.tone}>
                  {banner.text}{" "}
                  <button type="button" className="link" onClick={() => setBanner(null)}>
                    Dismiss
                  </button>
                </Notice>
              </div>
            )}
            {status.error && (
              <Notice tone="error">Cannot reach the Sortify server: {status.error}</Notice>
            )}
            {playlistMatch?.[1] ? (
              <PlaylistPage key={playlistMatch[1]} playlistId={playlistMatch[1]} />
            ) : runMatch?.[1] ? (
              <RunPage key={runMatch[1]} runId={Number(runMatch[1])} />
            ) : (
              <Welcome />
            )}
          </main>
        </div>
        <JobBar />
        {signInOpen && (
          <SignInDialog
            onClose={() => setSignInOpen(false)}
            onSignedIn={() => {
              setSignInOpen(false);
              setBanner({ tone: "good", text: "YouTube is connected." });
              refresh();
            }}
          />
        )}
      </div>
    </AppContext.Provider>
  );
}
