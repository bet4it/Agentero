/**
 * Papers library state (zustand vanilla): catalog rows, search query, folder
 * scope, and import/export busy flags. Query keystrokes now only re-render
 * library subscribers instead of the whole App.
 */

import { createStore } from "zustand/vanilla";
import { perfWait } from "@/lib/core/perf";
import { isTauri } from "@/lib/core/tauri";
import { listPapers, rescanPapers, setPaperTags } from "@/lib/paper/api";
import type { LocalPdfImportEntry } from "@/lib/paper/lookup";
import type { CitingScanResult } from "@/lib/paper/refs";
import type { PaperTagInput } from "@/lib/paper/tags";
import type { PaperLibraryRow, PaperMetadata } from "@/lib/paper/types";
import { watchRefreshDelayMs } from "@/lib/vault/shell-activity";
import { getVaultPath } from "@/lib/vault/store";

export type LibraryIoBusy =
	| "import"
	| "export"
	| "import-pdf"
	| "citing"
	| null;

export type { LocalPdfImportEntry };

type LibraryStore = {
	papers: PaperLibraryRow[];
	loading: boolean;
	/** Title search query for the papers library view. */
	query: string;
	/**
	 * Vault-relative folder filter for the single Library tab. Null = full
	 * library. Set by clicking org folders in the tree — no new tabs.
	 */
	scopePath: string | null;
	rescanning: boolean;
	ioBusy: LibraryIoBusy;
	/** Paper being edited in the Edit Metadata dialog (null = closed). */
	editMetaDraft: PaperMetadata | null;
	/** Finished reverse-citation scan shown in its dialog (null = closed). */
	citingScanDraft: CitingScanResult | null;
	/** Bump to force RecycleBinView reload after Empty Recycle Bin. */
	trashReloadSignal: number;
	/** Catalog rows by vault-relative path (for read action / is_read). */
	paperMetaByRelPath: Map<string, PaperMetadata>;
};

function indexByRelPath(papers: PaperMetadata[]): Map<string, PaperMetadata> {
	const map = new Map<string, PaperMetadata>();
	for (const p of papers) {
		if (!p.path) continue;
		map.set(p.path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""), p);
	}
	return map;
}

export const libraryStore = createStore<LibraryStore>(() => ({
	papers: [],
	loading: false,
	query: "",
	scopePath: null,
	rescanning: false,
	ioBusy: null,
	editMetaDraft: null,
	citingScanDraft: null,
	trashReloadSignal: 0,
	paperMetaByRelPath: new Map(),
}));

function tagsFingerprint(tags: PaperMetadata["tags"]): string {
	if (!tags?.length) return "";
	return tags
		.map((t) => (typeof t === "string" ? t : `${t.name}:${t.color ?? ""}`))
		.join("|");
}

/**
 * Content equality for catalog refreshes: watcher-driven reloads usually
 * return identical rows, and replacing the array anyway would re-render the
 * whole library and retrigger heatmap loads for every paper.
 */
function samePapers(a: PaperLibraryRow[], b: PaperLibraryRow[]): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		const x = a[i];
		const y = b[i];
		if (x === y) continue;
		if (
			x.path !== y.path ||
			x.updated_at !== y.updated_at ||
			x.is_read !== y.is_read ||
			x.has_pdf !== y.has_pdf ||
			x.title !== y.title ||
			(x.code_repo ?? "") !== (y.code_repo ?? "") ||
			tagsFingerprint(x.tags) !== tagsFingerprint(y.tags) ||
			JSON.stringify(x.custom_props ?? {}) !==
				JSON.stringify(y.custom_props ?? {})
		) {
			return false;
		}
	}
	return true;
}

/**
 * Open-bundle fill writes `code_repo` after the library snapshot. Paper Info
 * prefers this map over the tab copy, so patch the row or the chip stays empty.
 */
export function adoptLibraryCodeRepo(paper: PaperMetadata): void {
	const repo = paper.code_repo?.trim();
	if (!repo || !paper.path) return;
	setLibraryPapers((prev) =>
		prev.map((row) =>
			row.path === paper.path && (row.code_repo ?? "") !== repo
				? { ...row, code_repo: repo, updated_at: paper.updated_at }
				: row,
		),
	);
}

export function setLibraryPapers(
	next:
		| PaperLibraryRow[]
		| ((previous: PaperLibraryRow[]) => PaperLibraryRow[]),
): void {
	const papers =
		typeof next === "function" ? next(libraryStore.getState().papers) : next;
	const prev = libraryStore.getState();
	if (papers === prev.papers || samePapers(prev.papers, papers)) return;
	libraryStore.setState({ papers, paperMetaByRelPath: indexByRelPath(papers) });
}

export function setLibraryQuery(query: string): void {
	libraryStore.setState({ query });
}

export function setLibraryScopePath(
	next: string | null | ((previous: string | null) => string | null),
): void {
	if (typeof next === "function") {
		libraryStore.setState((s) => ({ scopePath: next(s.scopePath) }));
		return;
	}
	libraryStore.setState({ scopePath: next });
}

export function setLibraryRescanning(rescanning: boolean): void {
	libraryStore.setState({ rescanning });
}

export function setLibraryIoBusy(ioBusy: LibraryIoBusy): void {
	libraryStore.setState({ ioBusy });
}

export function setEditMetaDraft(draft: PaperMetadata | null): void {
	libraryStore.setState({ editMetaDraft: draft });
}

export function setCitingScanDraft(draft: CitingScanResult | null): void {
	libraryStore.setState({ citingScanDraft: draft });
}

export function bumpTrashReloadSignal(): void {
	libraryStore.setState((s) => ({
		trashReloadSignal: s.trashReloadSignal + 1,
	}));
}

export async function refreshLibrary(): Promise<void> {
	const vaultPath = getVaultPath();
	if (!vaultPath || !isTauri()) {
		setLibraryPapers([]);
		return;
	}
	libraryStore.setState({ loading: true });
	try {
		setLibraryPapers(await listPapers(vaultPath));
	} catch {
		setLibraryPapers([]);
	} finally {
		libraryStore.setState({ loading: false });
	}
}

/**
 * Replace a paper's tags in catalog and update the local library row.
 * Works for both local and remote vaults.
 */
export async function setLibraryPaperTags(
	vaultPath: string,
	path: string,
	tags: PaperTagInput[],
): Promise<void> {
	const updated = await setPaperTags(vaultPath, path, tags);
	// Merge over the row: `paper_set_tags` returns a bare record without the
	// `paper_list` local-PDF probe.
	setLibraryPapers((prev) =>
		prev.map((p) => (p.path === path ? { ...p, ...updated } : p)),
	);
}

/** Quiet catalog reload coalesced across external-change bursts (CLI, sync). */
let libraryRefreshTimer: ReturnType<typeof setTimeout> | null = null;

export async function runLibraryRefresh(): Promise<void> {
	libraryRefreshTimer = null;
	const vaultPath = getVaultPath();
	if (!vaultPath || !isTauri()) {
		setLibraryPapers([]);
		return;
	}
	try {
		// External moves (especially cross-directory drags in Finder) may not
		// arrive as a trustworthy rename pair. Rebuild catalog rows from disk
		// sidecars first so titles/metadata follow the new paths, then list.
		await rescanPapers(vaultPath);
		const papers = await listPapers(vaultPath);
		if (getVaultPath() === vaultPath) setLibraryPapers(papers);
	} catch {
		setLibraryPapers([]);
	}
}

/**
 * Quiet, debounced catalog reload for external tools (CLI, sync clients).
 * Avoids loading-state flicker while still updating tree labels and table rows.
 * Background / unfocused shells use a longer coalesce window.
 */
export function scheduleLibraryRefresh(): void {
	if (libraryRefreshTimer) clearTimeout(libraryRefreshTimer);
	const scheduledAt = performance.now();
	const delay = watchRefreshDelayMs("library");
	libraryRefreshTimer = setTimeout(() => {
		perfWait("watch_wait.library", performance.now() - scheduledAt);
		void runLibraryRefresh();
	}, delay);
}

/**
 * Drop catalog state belonging to the vault being closed. Leaves `query` /
 * `scopePath` to `activateVault` (cleared synchronously so the first frame of
 * the new vault is not filtered by the old one) and preserves
 * `trashReloadSignal`, whose monotonic value subscribers compare against.
 */
export function clearLibraryVaultState(): void {
	if (libraryRefreshTimer) {
		clearTimeout(libraryRefreshTimer);
		libraryRefreshTimer = null;
	}
	libraryStore.setState({
		papers: [],
		paperMetaByRelPath: new Map(),
		editMetaDraft: null,
		citingScanDraft: null,
		loading: false,
		rescanning: false,
		ioBusy: null,
	});
}
