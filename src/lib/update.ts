import { useCallback, useEffect, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/**
 * In-app updates, in two halves that are deliberately far apart in time.
 *
 * The fetch is automatic and silent: by the time anything appears in the
 * titlebar the new version is already on disk, so the button is a restart and
 * not a download. The restart is never automatic, because restarting zero
 * closes every terminal in it and a terminal here may be holding a Claude
 * session mid-task. That is a thing to be asked about, not told about, which
 * is why nothing in this file calls relaunch() on its own.
 *
 * A failed check is not worth a word to anyone. Offline is the usual reason,
 * and the app's own version is not news the user is waiting on.
 */

/** how often to look, once the first check has been and gone */
const EVERY_MS = 6 * 60 * 60 * 1000;

export interface UpdateState {
  /** version string once it's downloaded and ready to install, else null */
  ready: string | null;
  /** install and relaunch — the caller has already asked */
  restart: () => Promise<void>;
}

export function useUpdate(): UpdateState {
  const [ready, setReady] = useState<string | null>(null);
  const [update, setUpdate] = useState<Update | null>(null);

  useEffect(() => {
    let stop = false;
    const look = async () => {
      // one at a time, and never again once one is waiting: downloading a
      // second update over the first would swap the bundle under the version
      // the button is offering
      if (stop || update) return;
      const found = await check().catch(() => null);
      if (!found?.available || stop) return;
      // downloadAndInstall stages the new bundle; on macOS the swap happens
      // here and the running app carries on out of the copy it already has,
      // which is why this is safe to do without asking and the restart isn't
      await found.downloadAndInstall().catch(() => null);
      if (stop) return;
      setUpdate(found);
      setReady(found.version);
    };
    void look();
    const iv = window.setInterval(look, EVERY_MS);
    return () => {
      stop = true;
      window.clearInterval(iv);
    };
  }, [update]);

  const restart = useCallback(async () => {
    await relaunch();
  }, []);

  return { ready, restart };
}
