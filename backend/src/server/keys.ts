/**
 * The `/api/keys/*` routes and the key-sync view, shared by the server (`app.ts`) and the static
 * build (`web/src/api.ts`). Free of `node:` imports.
 *
 * The two shells differ in one way: the browser can rewrite the keys it holds itself, the server
 * cannot touch its `.env`. So in the browser, turning sync on moves this device's keys into the
 * sync file (otherwise a local copy would keep winning over an edit made on another device),
 * and turning it off or removing the synced keys copies them back first, so nothing stops
 * working here. On the server the keys in `.env` simply stay where they are and keep winning.
 */
import type { KeySyncView } from "../api/types.ts";
import {
  forgetSyncedKeys,
  type KeyStore,
  keyChanges,
  liveKeys,
  localSyncableKeys,
  setUsesSyncedKeys,
  usesSyncedKeys,
} from "../sync/keys.ts";
import { asObject, RequestError } from "./validate.ts";

/** The keys a device holds itself. */
export interface DeviceKeys {
  read(): Record<string, string | undefined>;
  /** Sets keys here; a blank value removes one. Absent when they cannot be written (`.env`). */
  write?: (values: Record<string, string>) => void;
}

export const keySyncView = (store: KeyStore, device: DeviceKeys): KeySyncView => ({
  enabled: usesSyncedKeys(store),
  inDrive: Object.keys(liveKeys(store.syncedKeys())),
  onDevice: Object.keys(localSyncableKeys(device.read())),
  keysMovable: device.write !== undefined,
});

/** Keys travel in the sync file, so every key route needs sync to be on. */
export function requireSync<T>(sync: T | undefined): T {
  if (!sync) {
    throw new RequestError(409, "Keys travel through Google Drive. Connect YouTube to sync first.");
  }
  return sync;
}

/**
 * Records `values` in the sync file and, on a device that can, clears its own copies of them,
 * so the synced value is the one in use. Only tag-source keys move; anything else in `values`
 * (the Google client) is left to the caller.
 */
export function moveToSync(
  store: KeyStore,
  device: DeviceKeys,
  values: Record<string, string>,
): void {
  const changes = keyChanges(values);
  if (changes.length === 0) return;
  store.putSyncedKeys(changes);
  device.write?.(Object.fromEntries(changes.map((k) => [k.name, ""])));
}

/** Copies synced keys this device does not hold itself onto it, so they keep working here. */
function keepLocally(store: KeyStore, device: DeviceKeys): void {
  if (!device.write) return;
  const local = device.read();
  const missing = Object.entries(liveKeys(store.syncedKeys())).filter(
    ([name]) => !local[name]?.trim(),
  );
  if (missing.length > 0) device.write(Object.fromEntries(missing));
}

/** `POST /api/keys/sync` with `{ enabled }`: this device's switch. */
export function setKeySync(store: KeyStore, device: DeviceKeys, body: unknown): KeySyncView {
  const { enabled } = asObject(body);
  if (typeof enabled !== "boolean") throw new RequestError(400, "enabled must be true or false");
  if (enabled && device.write) moveToSync(store, device, localSyncableKeys(device.read()));
  if (!enabled) keepLocally(store, device);
  setUsesSyncedKeys(store, enabled);
  return keySyncView(store, device);
}

/**
 * `POST /api/keys/share`: puts this device's own tag-source keys into the sync file. A browser
 * moves them (see `moveToSync`); a server copies them out of its `.env`, which stays as it is.
 */
export function shareKeys(store: KeyStore, device: DeviceKeys): KeySyncView {
  if (!usesSyncedKeys(store)) {
    throw new RequestError(409, "Turn on key sync on this device first.");
  }
  const mine = localSyncableKeys(device.read());
  if (Object.keys(mine).length === 0) {
    throw new RequestError(409, "This device has no tag-source keys of its own to share.");
  }
  moveToSync(store, device, mine);
  return keySyncView(store, device);
}

/**
 * `POST /api/keys/forget`: removes the keys from the sync file on every device, and turns key
 * sync off here. Devices that use them lose them on their next sync, unless they hold their own.
 */
export function forgetKeys(store: KeyStore, device: DeviceKeys): KeySyncView {
  keepLocally(store, device);
  forgetSyncedKeys(store);
  setUsesSyncedKeys(store, false);
  return keySyncView(store, device);
}
