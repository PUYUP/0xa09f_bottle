import { useSyncExternalStore } from "react";
import { getState, subscribe, type AppState } from "../lib/store";

export function useApp(): AppState {
  return useSyncExternalStore(subscribe, getState);
}
