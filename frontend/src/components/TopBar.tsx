import { useState } from "react";
import { useApp } from "../App.tsx";
import { api } from "../api.ts";
import type { Theme } from "../hooks.ts";
import {
  IconClose,
  IconMenu,
  IconMonitor,
  IconMoon,
  IconSignIn,
  IconSignOut,
  IconSun,
} from "./icons.tsx";
import { Button, Menu, MenuItem } from "./ui.tsx";

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
  const { status, theme, setTheme, openSignIn, refresh, notify, navigate } = useApp();
  const [signingOut, setSigningOut] = useState(false);

  const sources = status?.sources ?? [];
  const ready = sources.filter((s) => s.configured).length;
  const signedIn = status?.signedIn ?? false;

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
            label="Connections"
            wide
            trigger={
              <>
                <span className={signedIn ? "dot dot-on" : "dot dot-off"} aria-hidden />
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
                  <li className={signedIn ? "source-row on" : "source-row"}>
                    <span className={signedIn ? "dot dot-on" : "dot dot-off"} aria-hidden />
                    <div>
                      <div className="source-name">YouTube</div>
                      <p className="source-help">
                        {signedIn
                          ? "Reads your playlists and creates new ones. It never changes or deletes existing playlists."
                          : "Needed to add playlists and to create new ones."}
                      </p>
                    </div>
                  </li>
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

                <div className="menu-sep" />

                <div className="menu-label menu-label-row">
                  <span className="eyebrow">Tag sources</span>
                  <span className="menu-count tabular">
                    {ready} of {sources.length} ready
                  </span>
                </div>
                <ul className="source-list">
                  {sources.map((s) => (
                    <li key={s.id} className={s.configured ? "source-row on" : "source-row"}>
                      <span className={s.configured ? "dot dot-on" : "dot dot-off"} aria-hidden />
                      <div>
                        <div className="source-name">
                          {s.label}
                          <span className="source-state">{s.configured ? "Ready" : "Off"}</span>
                        </div>
                        <p className="source-help">{s.help}</p>
                        {!s.configured && s.envVars.length > 0 && (
                          <div className="source-keys">
                            {s.envVars.map((v) => (
                              <code key={v}>{v}</code>
                            ))}
                          </div>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
                {ready < sources.length && (
                  <p className="menu-foot">
                    Set the keys above, then restart <code>sortify ui</code>.
                  </p>
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
            Connect YouTube
          </Button>
        )}
      </div>
    </header>
  );
}
