import { useState } from "react";
import { useApp } from "../App.tsx";
import { api } from "../api.ts";
import { Button } from "./ui.tsx";

const SOURCES = [
  { key: "musicbrainz", name: "MusicBrainz", help: "Corrects artist and title spelling." },
  {
    key: "discogs",
    name: "Discogs",
    help: "Main subgenre source. Set DISCOGS_TOKEN and restart `sortify ui`.",
  },
  {
    key: "lastfm",
    name: "Last.fm",
    help: "The only mood source. Set LASTFM_API_KEY and restart `sortify ui`.",
  },
] as const;

export function TopBar() {
  const { status, openSignIn, refresh } = useApp();
  const [signingOut, setSigningOut] = useState(false);

  return (
    <header className="topbar">
      <div className="brand">
        <svg viewBox="0 0 32 32" aria-hidden className="brand-mark">
          <rect width="32" height="32" rx="8" />
          <rect x="7" y="9" width="18" height="3" rx="1.5" className="bar" />
          <rect x="7" y="15" width="12" height="3" rx="1.5" className="bar" opacity=".85" />
          <rect x="7" y="21" width="7" height="3" rx="1.5" className="bar" opacity=".7" />
        </svg>
        <span>Sortify</span>
      </div>

      <div className="topbar-right">
        <ul className="sources" aria-label="Tag sources">
          {SOURCES.map((s) => {
            const on = status?.sources[s.key] ?? false;
            return (
              <li
                key={s.key}
                className={on ? "source on" : "source off"}
                title={on ? s.help.split(".")[0] : s.help}
              >
                <span className="dot" aria-hidden />
                {s.name}
                <span className="sr-only">{on ? " connected" : " not configured"}</span>
              </li>
            );
          })}
        </ul>

        {status?.signedIn ? (
          <div className="account">
            <span className="account-state">
              <span className="dot on" aria-hidden />
              YouTube connected
            </span>
            <Button
              variant="ghost"
              busy={signingOut}
              onClick={async () => {
                setSigningOut(true);
                await api("/api/auth/signout", { method: "POST" }).finally(() =>
                  setSigningOut(false),
                );
                refresh();
              }}
            >
              Sign out
            </Button>
          </div>
        ) : (
          <Button variant="primary" onClick={openSignIn}>
            Connect YouTube
          </Button>
        )}
      </div>
    </header>
  );
}
