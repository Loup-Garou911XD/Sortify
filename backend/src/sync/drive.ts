/**
 * The snapshot's home: one file in Google Drive's `appDataFolder`.
 *
 * `appDataFolder` is a hidden per-app, per-user folder. It does not show up in the user's Drive,
 * no other app can read it, and it needs no new infrastructure — the OAuth client the app
 * already uses just has to ask for `drive.appdata` as well.
 *
 * Like the YouTube client this is plain `fetch` with the token provider injected, so it runs in
 * both shells and tests can hand it a fake.
 */
import type { TokenProvider } from "../youtube/client.ts";
import type { Snapshot } from "./snapshot.ts";

/** Read and write a hidden folder of this app's own, and nothing else in the user's Drive. */
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";

const FILES = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const FILE_NAME = "sortify-sync.json";
const FOLDER = "appDataFolder";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Where a snapshot sits in Drive, and when it last changed. */
export interface RemoteFile {
  id: string;
  /** Drive's own clock, used to notice that someone else wrote since we last looked. */
  modifiedTime: string;
}

export class DriveAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DriveAuthError";
  }
}

/**
 * Says why Google refused, because 403 covers two very different problems and the fix for one
 * is no use for the other: a token that predates the `drive.appdata` scope, or a Cloud project
 * where the Drive API was never switched on.
 */
async function refusal(res: Response): Promise<DriveAuthError> {
  const body = await res.text().catch(() => "");
  // Google's own text carries a console link with the project id already in it, which is far
  // more useful than anything that can be written here, so it is passed through.
  let detail = "";
  try {
    const message = (JSON.parse(body) as { error?: { message?: string } }).error?.message;
    if (message) detail = ` Google says: ${message}`;
  } catch {
    // Not JSON; the status alone will have to do.
  }
  const reason = /accessNotConfigured|has not been used in project|SERVICE_DISABLED/.test(body)
    ? "disabled"
    : /insufficient|ACCESS_TOKEN_SCOPE_INSUFFICIENT|forbidden/i.test(body)
      ? "scope"
      : "unknown";
  if (reason === "disabled") {
    return new DriveAuthError(
      "Syncing needs the Google Drive API, which is not enabled for your Cloud project. Enable " +
        `it at console.cloud.google.com/apis/library/drive.googleapis.com, then try again.${detail}`,
    );
  }
  if (reason === "scope") {
    return new DriveAuthError(
      "This sign-in predates syncing, so it does not cover the Drive folder. Sign out and " +
        `connect YouTube again to grant it.${detail}`,
    );
  }
  return new DriveAuthError(
    `Google refused access to the Sortify sync folder (${res.status}). Sign in again, and check ` +
      `that the Google Drive API is enabled for your Cloud project.${detail}`,
  );
}

interface FileResource {
  id?: string;
  modifiedTime?: string;
}

export class DriveSnapshots {
  private readonly fetchImpl: FetchLike;
  private readonly getAccessToken: TokenProvider["getAccessToken"];

  constructor(deps: { getAccessToken: TokenProvider["getAccessToken"]; fetch?: FetchLike }) {
    this.getAccessToken = deps.getAccessToken;
    // `fetch` is a method of the global object: capturing it unbound and calling it through a
    // variable throws "Illegal invocation" in browsers, though it works in Node.
    this.fetchImpl = deps.fetch ?? fetch.bind(globalThis);
  }

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    const { token } = await this.getAccessToken();
    if (!token) throw new DriveAuthError("Not signed in to Google.");
    const res = await this.fetchImpl(url, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${token}` },
    });
    if (res.status === 401 || res.status === 403) throw await refusal(res);
    if (!res.ok) {
      throw new Error(`Google Drive returned ${res.status} ${res.statusText}`.trim());
    }
    return res;
  }

  /** The snapshot file, or undefined when this account has never synced. */
  async find(): Promise<RemoteFile | undefined> {
    const params = new URLSearchParams({
      spaces: FOLDER,
      q: `name = '${FILE_NAME}' and trashed = false`,
      fields: "files(id,modifiedTime)",
      pageSize: "1",
    });
    const res = await this.request(`${FILES}?${params}`);
    const body = (await res.json()) as { files?: FileResource[] };
    const file = body.files?.[0];
    return file?.id && file.modifiedTime
      ? { id: file.id, modifiedTime: file.modifiedTime }
      : undefined;
  }

  async download(file: RemoteFile): Promise<Snapshot> {
    const res = await this.request(`${FILES}/${file.id}?alt=media`);
    return (await res.json()) as Snapshot;
  }

  /** Creates the file on first sync. Multipart, so metadata and content go in one request. */
  async create(snapshot: Snapshot): Promise<RemoteFile> {
    const boundary = `sortify${Math.random().toString(36).slice(2)}`;
    const metadata = JSON.stringify({ name: FILE_NAME, parents: [FOLDER] });
    const body = [
      `--${boundary}`,
      "Content-Type: application/json; charset=UTF-8",
      "",
      metadata,
      `--${boundary}`,
      "Content-Type: application/json; charset=UTF-8",
      "",
      JSON.stringify(snapshot),
      `--${boundary}--`,
      "",
    ].join("\r\n");
    const res = await this.request(`${UPLOAD}?uploadType=multipart&fields=id,modifiedTime`, {
      method: "POST",
      headers: { "content-type": `multipart/related; boundary=${boundary}` },
      body,
    });
    return this.asRemote(await res.json());
  }

  async update(file: RemoteFile, snapshot: Snapshot): Promise<RemoteFile> {
    const res = await this.request(`${UPLOAD}/${file.id}?uploadType=media&fields=id,modifiedTime`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(snapshot),
    });
    return this.asRemote(await res.json());
  }

  private asRemote(body: unknown): RemoteFile {
    const file = body as FileResource;
    if (!file.id || !file.modifiedTime) throw new Error("Google Drive returned an unusable file.");
    return { id: file.id, modifiedTime: file.modifiedTime };
  }
}
