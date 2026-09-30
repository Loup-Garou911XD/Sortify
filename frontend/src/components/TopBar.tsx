import { useState } from "react";
import { useApp } from "../App.tsx";
import { api } from "../api.ts";
import type { Theme } from "../hooks.ts";
import { IconClose, IconMenu, IconMonitor, IconMoon, IconSignOut, IconSun } from "./icons.tsx";
import { Button, Menu, MenuItem } from "./ui.tsx";

const THEMES: { value: Theme; label: string; Glyph: typeof IconSun }[] = [
  { value: "light", label: "Light", Glyph: IconSun },
  { value: "dark", label: "Dark", Glyph: IconMoon },
  { value: "system", label: "Match system", Glyph: IconMonitor },
];

export function TopBar({
  drawerOpen,
  onToggleDrawer,
}: {
  drawerOpen: boolean;
  onToggleDrawer: () => void;
}) {
  const { status, theme, setTheme, openSignIn, refresh, notify } = useApp();
  const [signingOut, setSigningOut] = useState(false);

  const sources = status?.sources ?? [];
  const ready = sources.filter((s) => s.configured).length;
  const ThemeGlyph = THEMES.find((t) => t.value === theme)?.Glyph ?? IconMonitor;

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
        <span className="brand">
          <svg viewBox="0 0 32 32" aria-hidden className="brand-mark">
            <rect width="32" height="32" rx="8" />
            <rect x="7" y="9" width="18" height="3" rx="1.5" className="bar" />
            <rect x="7" y="15" width="12" height="3" rx="1.5" className="bar" opacity=".85" />
            <rect x="7" y="21" width="7" height="3" rx="1.5" className="bar" opacity=".7" />
          </svg>
          Sortify
        </span>
      </div>

      <div className="topbar-right">
        {sources.length > 0 && (
          <Menu
            label="Tag sources"
            wide
            trigger={
              <>
                <span
                  className={ready === sources.length ? "dot dot-on" : "dot dot-off"}
                  aria-hidden
                />
                <span className="tabular">
                  {ready}/{sources.length}
                  <span className="trigger-word"> sources</span>
                </span>
              </>
            }
          >
            {() => (
              <>
                <div className="menu-label">
                  <span className="eyebrow">Tag sources</span>
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
                  <>
                    <div className="menu-sep" />
                    <p className="source-help" style={{ padding: "0 9px 6px" }}>
                      Set the keys above, then restart <code>sortify ui</code>.
                    </p>
                  </>
                )}
              </>
            )}
          </Menu>
        )}

        <Menu label="Theme" trigger={<ThemeGlyph />}>
          {(close) => (
            <>
              <div className="menu-label">
                <span className="eyebrow">Theme</span>
              </div>
              <fieldset className="menu-group">
                <legend className="sr-only">Theme</legend>
                {THEMES.map(({ value, label, Glyph }) => (
                  <MenuItem
                    key={value}
                    selected={theme === value}
                    onClick={() => {
                      setTheme(value);
                      close();
                    }}
                  >
                    <Glyph size={15} />
                    {label}
                  </MenuItem>
                ))}
              </fieldset>
            </>
          )}
        </Menu>

        {status?.signedIn ? (
          <Menu
            label="YouTube account"
            trigger={
              <span className="account-chip">
                <span className="dot dot-on" aria-hidden />
                <span className="trigger-word">YouTube</span>
              </span>
            }
          >
            {(close) => (
              <>
                <div className="menu-label">
                  <span className="eyebrow">Connected</span>
                  <div className="small muted">Sortify can read and create your playlists.</div>
                </div>
                <div className="menu-sep" />
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
              </>
            )}
          </Menu>
        ) : (
          <Button variant="primary" onClick={openSignIn}>
            Connect YouTube
          </Button>
        )}
      </div>
    </header>
  );
}
