import { listen } from "@tauri-apps/api/event";

// Single global listener for pty events, dispatched by session id,
// so N terminal panes don't each deserialize every event.

type OutputHandler = (bytes: Uint8Array) => void;
type ExitHandler = () => void;

const outputHandlers = new Map<string, OutputHandler>();
const exitHandlers = new Map<string, ExitHandler>();
let started = false;

function ensureStarted() {
  if (started) return;
  started = true;
  listen<{ id: string; bytes: number[] }>("pty-output", (e) => {
    outputHandlers.get(e.payload.id)?.(new Uint8Array(e.payload.bytes));
  });
  listen<{ id: string }>("pty-exit", (e) => {
    exitHandlers.get(e.payload.id)?.();
  });
}

export const ptyBus = {
  onOutput(id: string, fn: OutputHandler) {
    ensureStarted();
    outputHandlers.set(id, fn);
  },
  onExit(id: string, fn: ExitHandler) {
    ensureStarted();
    exitHandlers.set(id, fn);
  },
  off(id: string) {
    outputHandlers.delete(id);
    exitHandlers.delete(id);
  },
};
