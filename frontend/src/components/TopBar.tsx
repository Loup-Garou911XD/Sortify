import { useState } from "react";
import type { SyncView } from "../../../backend/src/api/types.ts";
import { useApp } from "../App.tsx";
import { api } from "../api.ts";
import type { Theme } from "../hooks.ts";
import {
  IconClose,
  IconInbox,
  IconMenu,
  IconMonitor,
  IconMoon,
  IconPlug,
  IconRefresh,
  IconSignIn,
  IconSignOut,
  IconSun,
} from "./icons.tsx";
import { Button, Menu, MenuItem } from "./ui.tsx";

/**
 * How a connection reads at a glance: working, not set up, busy, or broken. The dot and the
 * spinning ring in the top bar are the same four, so the trigger and the panel never disagree.
 */
type Tone = "on" | "off" | "sync" | "bad";

/**
 * One row of the Connections panel. It is a plain block normally, and a button when the shell
 * passed `configureSource`, so the local app shows exactly what it always has.
 */
function SourceRow({
  tone,
  name,
  state,
  help,
  keys = [],
  onClick,
}: {
  tone: Tone;
  name: string;
  state?: string;
  help: string;
  keys?: string[];
  onClick?: (() => void) | undefined;
}) {
  const body = (
    <>
      <span className={`dot dot-${tone}`} aria-hidden />
      <div>
        <div className="source-name">
          {name}
          {state && <span className="source-state">{state}</span>}
        </div>
        <p className="source-help">{help}</p>
        {keys.length > 0 && (
          <div className="source-keys">
            {keys.map((v) => (
              <code key={v}>{v}</code>
            ))}
          </div>
        )}
      </div>
    </>
  );
  return (
    <li className={tone === "on" ? "source-row-item on" : "source-row-item"}>
      {onClick ? (
        <button type="button" className="source-row source-row-button" onClick={onClick}>
          {body}
        </button>
      ) : (
        <div className="source-row">{body}</div>
      )}
    </li>
  );
}

const SYNC_LABEL = {
  idle: "Up to date",
  syncing: "Syncing\u2026",
  offline: "Not reachable",
  "needs-auth": "Needs sign-in",
} as const;

const SYNC_TONE = {
  idle: "on",
  syncing: "sync",
  offline: "bad",
  "needs-auth": "bad",
} as const satisfies Record<SyncView["state"], Tone>;

/** The dot's own wording. Short on purpose: the panel below carries the detail and the fix. */
const SYNC_DOT_TEXT = {
  idle: "Up to date with Google Drive",
  syncing: "Syncing with Google Drive\u2026",
  offline: "Google Drive is not reachable",
  "needs-auth": "Google Drive needs you to sign in again",
} as const satisfies Record<SyncView["state"], string>;

/**
 * The one dot in the top bar. Anything but a settled sync wins, so a broken or in-flight Drive
 * shows through; being signed out comes last, because it is a step not taken yet, not a fault.
 */
function connection(signedIn: boolean, sync: SyncView | null): { tone: Tone; text: string } {
  if (sync && SYNC_TONE[sync.state] !== "on") {
    return { tone: SYNC_TONE[sync.state], text: SYNC_DOT_TEXT[sync.state] };
  }
  if (signedIn) return { tone: "on", text: sync ? SYNC_DOT_TEXT.idle : "YouTube connected" };
  return { tone: "off", text: "Not connected" };
}

/** What the Drive row says under its name: the problem if there is one, else what it does. */
function syncHelp(sync: SyncView): string {
  if (sync.message) return sync.message;
  const notes: string[] = [];
  if (sync.renamedRuns.length > 0) {
    const moved = sync.renamedRuns.map((r) => `${r.from} \u2192 ${r.to}`).join(", ");
    notes.push(`Plans renumbered to keep them apart from another device's: ${moved}.`);
  }
  if (sync.conflictedRuns.length > 0) {
    notes.push(
      `Plan ${sync.conflictedRuns.join(", ")} is part-created on two devices and was left alone; finish or delete it on one of them.`,
    );
  }
  return notes.length > 0
    ? notes.join(" ")
    : "Playlists, tags and plans are kept in step across your devices.";
}

/** Each theme names the one the toggle moves to, so a single button reaches all three. */
const THEMES: Record<Theme, { label: string; Glyph: typeof IconSun; next: Theme }> = {
  light: { label: "Light", Glyph: IconSun, next: "dark" },
  dark: { label: "Dark", Glyph: IconMoon, next: "system" },
  system: { label: "Match system", Glyph: IconMonitor, next: "light" },
};

export function TopBar({
  drawerOpen,
  onToggleDrawer,
}: {
  drawerOpen: boolean;
  onToggleDrawer: () => void;
}) {
  const {
    status,
    sync,
    theme,
    setTheme,
    openSignIn,
    syncNow,
    refresh,
    notify,
    navigate,
    configureSource,
  } = useApp();
  const [signingOut, setSigningOut] = useState(false);

  const sources = status?.sources ?? [];
  const ready = sources.filter((s) => s.configured).length;
  const signedIn = status?.signedIn ?? false;

  const conn = connection(signedIn, sync);

  const now = THEMES[theme];
  const next = THEMES[now.next];
  const ThemeGlyph = now.Glyph;

  const signOut = async () => {
    setSigningOut(true);
    try {
      await api("/api/auth/signout", { method: "POST" });
      notify("good", "Signed out of YouTube.");
      refresh();
    } catch (err) {
      notify("error", (err as Error).message);
    } finally {
      setSigningOut(false);
    }
  };

  const manualSync = async () => {
    try {
      await syncNow();
    } catch (err) {
      notify("error", (err as Error).message);
    }
  };

  return (
    <header className="topbar">
      <div className="topbar-left">
        <Button
          variant="ghost"
          className="btn-icon drawer-toggle"
          aria-label={drawerOpen ? "Close the menu" : "Open the menu"}
          aria-expanded={drawerOpen}
          onClick={onToggleDrawer}
        >
          {drawerOpen ? <IconClose /> : <IconMenu />}
        </Button>
        <a
          className="brand"
          href="/"
          aria-label="Sortify home"
          onClick={(e) => {
            e.preventDefault();
            navigate("/");
          }}
        >
          <svg viewBox="0 0 32 32" aria-hidden className="brand-mark">
            <rect width="32" height="32" rx="8" />
            <rect x="7" y="9" width="18" height="3" rx="1.5" className="bar" />
            <rect x="7" y="15" width="12" height="3" rx="1.5" className="bar" opacity=".85" />
            <rect x="7" y="21" width="7" height="3" rx="1.5" className="bar" opacity=".7" />
          </svg>
          Sortify
        </a>
      </div>

      <div className="topbar-right">
        {status && (
          <Menu
            label={`Connections: ${conn.text}`}
            wide
            trigger={
              <>
                <span className={`dot dot-${conn.tone}`} title={conn.text} aria-hidden />
                <IconPlug size={15} className="trigger-icon" />
                <span className="trigger-word">Connections</span>
              </>
            }
          >
            {(close) => (
              <>
                <div className="menu-label menu-label-row">
                  <span className="eyebrow">YouTube account</span>
                  <span className="menu-count">{signedIn ? "Connected" : "Not connected"}</span>
                </div>
                <ul className="source-list">
                  <SourceRow
                    tone={signedIn ? "on" : "off"}
                    name="YouTube"
                    help={
                      signedIn
                        ? "Reads your playlists and creates new ones. It never changes or deletes existing playlists."
                        : "Needed to add playlists and to create new ones."
                    }
                    onClick={
                      configureSource &&
                      (() => {
                        close();
                        configureSource("account");
                      })
                    }
                  />
                </ul>
                {signedIn ? (
                  <MenuItem
                    onClick={() => {
                      close();
                      void signOut();
                    }}
                  >
                    {signingOut ? (
                      <span className="spinner" aria-hidden />
                    ) : (
                      <IconSignOut size={15} />
                    )}
                    Sign out
                  </MenuItem>
                ) : (
                  <MenuItem
                    onClick={() => {
                      close();
                      openSignIn();
                    }}
                  >
                    <IconSignIn size={15} />
                    Connect YouTube
                  </MenuItem>
                )}

                {sync && (
                  <>
                    <div className="menu-sep" />
                    <div className="menu-label menu-label-row">
                      <span className="eyebrow">Sync</span>
                      <span className="menu-count">{SYNC_LABEL[sync.state]}</span>
                    </div>
                    <ul className="source-list">
                      <SourceRow
                        tone={SYNC_TONE[sync.state]}
                        name="Google Drive"
                        help={syncHelp(sync)}
                        onClick={
                          sync.state === "needs-auth"
                            ? () => {
                                close();
                                openSignIn();
                              }
                            : undefined
                        }
                      />
                    </ul>
                    {sync.state !== "needs-auth" && (
                      <MenuItem
                        disabled={sync.state === "syncing"}
                        onClick={() => {
                          close();
                          void manualSync();
                        }}
                      >
                        {sync.state === "syncing" ? (
                          <span className="spinner" aria-hidden />
                        ) : (
                          <IconRefresh size={15} />
                        )}
                        Sync now
                      </MenuItem>
                    )}
                  </>
                )}

                <div className="menu-sep" />

                <div className="menu-label menu-label-row">
                  <span className="eyebrow">Tag sources</span>
                  <span className="menu-count tabular">
                    {ready} of {sources.length} ready
                  </span>
                </div>
                <ul className="source-list">
                  {sources.map((s) => (
                    <SourceRow
                      key={s.id}
                      tone={s.configured ? "on" : "off"}
                      name={s.label}
                      state={s.configured ? "Ready" : "Off"}
                      help={s.help}
                      keys={!configureSource && !s.configured ? s.envVars : []}
                      onClick={
                        configureSource &&
                        (() => {
                          close();
                          configureSource(s.id);
                        })
                      }
                    />
                  ))}
                </ul>
                {ready < sources.length && !configureSource && (
                  <p className="menu-foot">
                    Set the keys above, then restart <code>sortify ui</code>.
                  </p>
                )}
                {configureSource && (
                  <MenuItem
                    onClick={() => {
                      close();
                      configureSource("import");
                    }}
                  >
                    <IconInbox size={15} />
                    Import keys from a .env file
                  </MenuItem>
                )}
              </>
            )}
          </Menu>
        )}

        <Button
          variant="ghost"
          className="btn-icon"
          aria-label={`Theme: ${now.label}. Switch to ${next.label.toLowerCase()}.`}
          title={`Theme: ${now.label} — switch to ${next.label.toLowerCase()}`}
          onClick={() => setTheme(now.next)}
        >
          <ThemeGlyph />
        </Button>

        {!signedIn && (
          <Button variant="primary" onClick={openSignIn}>
            Connect<span className="trigger-word"> YouTube</span>
          </Button>
        )}
      </div>
    </header>
  );
}
