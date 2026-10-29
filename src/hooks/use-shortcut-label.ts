import { useStore } from "zustand";
import { settingsStore } from "@/lib/settings/react-store";
import {
	formatShortcut,
	getShortcut,
	type ShortcutId,
} from "@/lib/shell/shortcuts";

/** Subscribe shortcut hints to both local edits and cross-window settings. */
export function useShortcutLabel(id: ShortcutId): string {
	const overrides = useStore(settingsStore, (state) => state.shortcutOverrides);
	const def = getShortcut(id, overrides);
	return def ? formatShortcut(def) : "";
}
