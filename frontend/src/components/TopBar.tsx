import { useState } from "react";
import { useApp } from "../App.tsx";
import { api } from "../api.ts";
import { Button } from "./ui.tsx";

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
          {(status?.sources ?? []).map((s) => {
            const help = s.configured
              ? s.help
              : `${s.help} Set ${s.envVars.join(" and ")} and restart \`sortify ui\`.`;
            return (
              <li key={s.id} className={s.configured ? "source on" : "source off"} title={help}>
                <span className="dot" aria-hidden />
                {s.label}
                <span className="sr-only">{s.configured ? " connected" : " not configured"}</span>
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
