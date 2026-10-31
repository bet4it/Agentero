/**
 * Writing surface session. The manuscript root and the last surface are
 * per vault; discovery results live only in memory.
 */

import { createStore } from "zustand/vanilla";
import { createPathRemapper, normalizePath } from "@/lib/core/path";
import {
	type Manuscript,
	manuscriptDir,
	readWritingPrefs,
	touchRecent,
	type WorkspaceSurface,
	writeWritingPrefs,
} from "@/lib/writing/session";

type WritingStore = {
	vaultPath: string | null;
	surface: WorkspaceSurface;
	activeRoot: string | null;
	/** File open in the writing editor. Not persisted; follows the project. */
	activeFile: string | null;
	/** Source files open as writing tabs. Session only. */
	openFiles: string[];
	recents: string[];
	manuscripts: Manuscript[];
	discovering: boolean;
	/** Change-history tab is open beside the source tabs. Session only. */
	historyOpen: boolean;
	/** The change-history tab is selected instead of a source file. */
	historyActive: boolean;
	/** Upload tab is open beside the source tabs. Session only. */
	syncOpen: boolean;
	/** The upload tab is selected instead of a source file. */
	syncActive: boolean;
};

export const writingStore = createStore<WritingStore>(() => ({
	vaultPath: null,
	surface: "reading",
	activeRoot: null,
	activeFile: null,
	openFiles: [],
	recents: [],
	manuscripts: [],
	discovering: false,
	historyOpen: false,
	historyActive: false,
	syncOpen: false,
	syncActive: false,
}));

function persist(): void {
	const { vaultPath, surface, activeRoot, recents } = writingStore.getState();
	if (!vaultPath) return;
	writeWritingPrefs(vaultPath, { surface, activeRoot, recents });
}

/** Load the vault's writing prefs. Same-vault calls keep discovered manuscripts. */
export function bindWritingVault(vaultPath: string | null): void {
	const current = writingStore.getState();
	if (current.vaultPath === vaultPath) return;
	if (!vaultPath) {
		writingStore.setState({
			vaultPath: null,
			surface: "reading",
			activeRoot: null,
			activeFile: null,
			openFiles: [],
			recents: [],
			manuscripts: [],
			discovering: false,
			historyOpen: false,
			historyActive: false,
			syncOpen: false,
			syncActive: false,
		});
		return;
	}
	const prefs = readWritingPrefs(vaultPath);
	writingStore.setState({
		vaultPath,
		// The workspace no longer restores a separate writing surface.
		surface: "reading",
		activeRoot: prefs.activeRoot,
		activeFile: prefs.activeRoot,
		openFiles: prefs.activeRoot ? [prefs.activeRoot] : [],
		recents: prefs.recents,
		manuscripts: [],
		discovering: false,
		historyOpen: false,
		historyActive: false,
		syncOpen: false,
		syncActive: false,
	});
}

export function setWritingSurface(surface: WorkspaceSurface): void {
	if (writingStore.getState().surface === surface) return;
	writingStore.setState({ surface });
	persist();
}

/** Follow a renamed or moved file/folder across project, tabs, and recents. */
export function remapWritingPaths(
	moves: readonly { from: string; to: string }[],
): void {
	if (moves.length === 0) return;
	const remap = createPathRemapper(moves);
	const state = writingStore.getState();
	writingStore.setState({
		activeRoot: state.activeRoot ? remap(state.activeRoot) : null,
		activeFile: state.activeFile ? remap(state.activeFile) : null,
		openFiles: state.openFiles.map(remap),
		recents: state.recents.map(remap),
	});
	persist();
}

export function selectManuscript(rootFile: string): void {
	const state = writingStore.getState();
	const same =
		state.activeRoot != null &&
		normalizePath(state.activeRoot) === normalizePath(rootFile);
	const recents = touchRecent(state.recents, rootFile);
	const files = same
		? rememberWritingFile(state.openFiles, state.activeFile ?? rootFile)
		: [rootFile];
	writingStore.setState({
		surface: "writing",
		activeRoot: rootFile,
		activeFile: same ? (state.activeFile ?? rootFile) : rootFile,
		openFiles: files,
		recents,
		...(same
			? {}
			: {
					historyOpen: false,
					historyActive: false,
					syncOpen: false,
					syncActive: false,
				}),
	});
	persist();
}

/**
 * Drop a deleted project from the session. The path is already gone.
 * `file` removes one manuscript that lived directly in `thesis/`.
 * `directory` removes every recent under that project folder.
 */
export function forgetWritingProject(
	rootFile: string,
	scope: "directory" | "file" = "directory",
): void {
	const state = writingStore.getState();
	if (scope === "file") {
		const key = normalizePath(rootFile);
		const recents = state.recents.filter((item) => normalizePath(item) !== key);
		const hitsActive =
			state.activeRoot != null && normalizePath(state.activeRoot) === key;
		writingStore.setState({
			recents,
			...(hitsActive
				? {
						activeRoot: null,
						activeFile: null,
						openFiles: [],
						historyOpen: false,
						historyActive: false,
						syncOpen: false,
						syncActive: false,
					}
				: {}),
		});
		persist();
		return;
	}
	const dirKey = normalizePath(manuscriptDir(rootFile));
	const recents = state.recents.filter((item) => {
		const itemDir = normalizePath(manuscriptDir(item));
		return itemDir !== dirKey && !itemDir.startsWith(`${dirKey}/`);
	});
	const activeDir = state.activeRoot
		? normalizePath(manuscriptDir(state.activeRoot))
		: "";
	const hitsActive =
		dirKey.length > 0 &&
		(activeDir === dirKey || activeDir.startsWith(`${dirKey}/`));
	writingStore.setState({
		recents,
		...(hitsActive
			? {
					activeRoot: null,
					activeFile: null,
					openFiles: [],
					historyOpen: false,
					historyActive: false,
					syncOpen: false,
					syncActive: false,
				}
			: {}),
	});
	persist();
}

/** Open or focus the change-history tab beside the source tabs. */
export function openWritingHistory(): void {
	writingStore.setState({
		historyOpen: true,
		historyActive: true,
		syncActive: false,
	});
}

export function closeWritingHistory(): void {
	writingStore.setState({ historyOpen: false, historyActive: false });
}

/** Open or focus the upload tab beside the source tabs. */
export function openWritingSync(): void {
	writingStore.setState({
		syncOpen: true,
		syncActive: true,
		historyActive: false,
	});
}

export function closeWritingSync(): void {
	writingStore.setState({ syncOpen: false, syncActive: false });
}

/** Open a source file in the writing editor. Does not touch the reading dock. */
export function setWritingFile(path: string): void {
	const state = writingStore.getState();
	writingStore.setState({
		activeFile: path,
		openFiles: rememberWritingFile(state.openFiles, path),
		historyActive: false,
		syncActive: false,
	});
}

/** Drop one writing tab. Closing the last tab leaves the project open with no editor. */
export function closeWritingFile(path: string): void {
	const state = writingStore.getState();
	const key = normalizePath(path);
	const index = state.openFiles.findIndex(
		(item) => normalizePath(item) === key,
	);
	if (index < 0) return;
	const next = state.openFiles.filter((_, item) => item !== index);
	const closingActive =
		state.activeFile != null && normalizePath(state.activeFile) === key;
	writingStore.setState({
		openFiles: next,
		activeFile: closingActive
			? (next[Math.min(index, next.length - 1)] ?? null)
			: state.activeFile,
	});
}

/** Keep one writing tab and close the rest. */
export function closeOtherWritingFiles(path: string): void {
	const state = writingStore.getState();
	const key = normalizePath(path);
	const kept = state.openFiles.filter((item) => normalizePath(item) === key);
	writingStore.setState({
		openFiles: kept,
		activeFile: kept[0] ?? null,
		historyOpen: false,
		historyActive: false,
		syncOpen: false,
		syncActive: false,
	});
}

/** Close every writing tab. The project and its PDF stay open. */
export function closeAllWritingFiles(): void {
	const state = writingStore.getState();
	if (state.openFiles.length === 0 && !state.historyOpen && !state.syncOpen)
		return;
	writingStore.setState({
		openFiles: [],
		activeFile: null,
		historyOpen: false,
		historyActive: false,
		syncOpen: false,
		syncActive: false,
	});
}

function rememberWritingFile(
	openFiles: readonly string[],
	path: string,
): string[] {
	const key = normalizePath(path);
	if (openFiles.some((item) => normalizePath(item) === key))
		return [...openFiles];
	return [...openFiles, path];
}

/**
 * Folder discovery replaces the project list. Keep the open project while its
 * folder exists; otherwise fall back to the first folder or close the project.
 */
export function setDiscoveredManuscripts(manuscripts: Manuscript[]): void {
	const state = writingStore.getState();
	const activeDir = state.activeRoot
		? normalizePath(manuscriptDir(state.activeRoot))
		: null;
	const active = activeDir
		? manuscripts.find(
				(item) => normalizePath(manuscriptDir(item.rootFile)) === activeDir,
			)
		: undefined;
	if (active && state.activeRoot) {
		if (normalizePath(active.rootFile) === normalizePath(state.activeRoot)) {
			writingStore.setState({ manuscripts, discovering: false });
			return;
		}
		const previous = state.activeRoot;
		const rootFile = active.rootFile;
		const replace = (path: string) =>
			normalizePath(path) === normalizePath(previous) ? rootFile : path;
		writingStore.setState({
			manuscripts,
			discovering: false,
			activeRoot: rootFile,
			activeFile: state.activeFile ? replace(state.activeFile) : null,
			openFiles: state.openFiles.map(replace),
		});
		persist();
		return;
	}
	const rootFile = manuscripts[0]?.rootFile ?? null;
	writingStore.setState({
		manuscripts,
		discovering: false,
		activeRoot: rootFile,
		activeFile: rootFile,
		openFiles: rootFile ? [rootFile] : [],
		historyOpen: false,
		historyActive: false,
		syncOpen: false,
		syncActive: false,
	});
	persist();
}

export function setWritingDiscovering(discovering: boolean): void {
	writingStore.setState({ discovering });
}
