import { useState } from "react";
import type {
  SourceTestResponse,
  SourceTestResult,
  SyncView,
} from "../../../backend/src/api/types.ts";
import { useApp } from "../App.tsx";
import { api } from "../api.ts";
import { plural, type Theme } from "../hooks.ts";
import {
  IconClose,
  IconInbox,
  IconMenu,
  IconMonitor,
  IconMoon,
  IconPlay,
  IconPlug,
  IconSignIn,
  IconSignOut,
  IconSun,
} from "./icons.tsx";
import { KeySyncDialog } from "./KeySyncDialog.tsx";
import { SYNC_LABEL, SYNC_TONE, SyncDialog } from "./SyncDialog.tsx";
import { Button, Menu, MenuItem, type Tone } from "./ui.tsx";

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
  note,
  onClick,
}: {
  tone: Tone;
  name: string;
  state?: string;
  help: string;
  keys?: string[];
  /** A line under the help, e.g. what a connection test found. */
  note?: { text: string; tone: "on" | "warn" | "bad" } | undefined;
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
        {note && (
          <p className={`source-note ${note.tone}`} role="status">
            {note.text}
          </p>
        )}
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
    <li className={`source-row-item ${tone}`}>
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

const TEST_TONE = {
  works: "on",
  limited: "warn",
  failed: "bad",
} as const satisfies Record<SourceTestResult["status"], Tone>;

const TEST_LABEL = {
  works: "Works",
  limited: "Limited",
  failed: "Failed",
} as const satisfies Record<SourceTestResult["status"], string>;

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
  const { status, sync, theme, setTheme, openSignIn, refresh, notify, navigate, configureSource } =
    useApp();
  const [signingOut, setSigningOut] = useState(false);
  /** The last connection test, per provider id; undefined until one has run. */
  const [tests, setTests] = useState<Record<string, SourceTestResult>>();
  const [testing, setTesting] = useState(false);
  /** Which popup the Sync rows opened. */
  const [dialog, setDialog] = useState<"sync" | "keys" | null>(null);
  const keySync = status?.keySync ?? null;

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

  const testSources = async () => {
    setTesting(true);
    try {
      const { results } = await api<SourceTestResponse>("/api/sources/test", { method: "POST" });
      setTests(Object.fromEntries(results.map((r) => [r.id, r])));
      const bad = results.filter((r) => r.status !== "works").length;
      notify(
        bad ? "error" : "good",
        bad
          ? `${bad} of ${results.length} tag sources failed or gave nothing usable.`
          : `All ${results.length} ready tag sources work.`,
      );
    } catch (err) {
      notify("error", (err as Error).message);
    } finally {
      setTesting(false);
    }
  };

  /** A tested source reads by its result; an untested one by its configuration alone. */
  const sourceTone = (id: string, configured: boolean): Tone => {
    if (!configured) return "off";
    if (testing) return "sync";
    return TEST_TONE[tests?.[id]?.status ?? "works"];
  };
  const sourceState = (id: string, configured: boolean, fromDrive: boolean): string => {
    if (!configured) return "Off";
    if (testing) return "Testing";
    const status = tests?.[id]?.status;
    if (status) return TEST_LABEL[status];
    return fromDrive ? "Synced" : "Ready";
  };

  const sourceNote = (id: string, configured: boolean) => {
    const result = configured && !testing ? tests?.[id] : undefined;
    if (!result) return undefined;
    const time = result.ms > 0 ? ` (${result.ms} ms)` : "";
    return { text: `${result.message}${time}`, tone: TEST_TONE[result.status] };
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
                        state={SYNC_LABEL[sync.state]}
                        help={
                          sync.message ??
                          "Playlists, tags and plans are kept in step across your devices."
                        }
                        onClick={() => {
                          close();
                          setDialog("sync");
                        }}
                      />
                      {keySync && (
                        <SourceRow
                          tone={keySync.enabled ? "on" : "off"}
                          name="API keys"
                          state={keySync.enabled ? "On" : "Off"}
                          help={
                            keySync.enabled
                              ? `${plural(keySync.inDrive.length, "key")} shared through Drive. Keys on this device come first.`
                              : "Share tag-source keys between your devices through Drive."
                          }
                          onClick={() => {
                            close();
                            setDialog("keys");
                          }}
                        />
                      )}
                    </ul>
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
                      tone={sourceTone(s.id, s.configured)}
                      name={s.label}
                      state={sourceState(s.id, s.configured, s.fromDrive === true)}
                      help={s.help}
                      note={sourceNote(s.id, s.configured)}
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
                {ready > 0 && (
                  // Stays open: the results land on the rows above.
                  <MenuItem disabled={testing} onClick={() => void testSources()}>
                    {testing ? <span className="spinner" aria-hidden /> : <IconPlay size={15} />}
                    {testing ? "Testing ready sources\u2026" : "Test ready sources"}
                  </MenuItem>
                )}
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

      {dialog === "sync" && sync && <SyncDialog onClose={() => setDialog(null)} />}
      {dialog === "keys" && keySync && (
        <KeySyncDialog initial={keySync} onClose={() => setDialog(null)} />
      )}
    </header>
  );
}
