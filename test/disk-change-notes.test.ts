import { beforeEach, describe, expect, it, vi } from "vitest";
import { notifyUndo } from "@/lib/core/notify";
import { clearWikiVaultState, trackSelfWrittenPath } from "@/lib/wiki/store";
import { createPlaceholderTab, type DocTab } from "@/lib/workspace/tabs";

const readVaultFileMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/vault", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/vault")>();
	return { ...actual, readVaultFile: readVaultFileMock };
});

vi.mock("@/lib/paper", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/paper")>();
	return {
		...actual,
		localFileToArrayBuffer: vi.fn(async () => new ArrayBuffer(0)),
	};
});

vi.mock("@/lib/core/notify", () => ({
	notifyError: vi.fn(),
	notifyUndo: vi.fn(),
	notifyWarning: vi.fn(),
	notifySuccess: vi.fn(),
}));

import { applyDiskChange } from "@/lib/workspace/actions";
import { markdownDiskConflicts } from "@/lib/workspace/persistence";

const PAPER = "/vault/papers/p1";
const NOTES = `${PAPER}/NOTES.md`;
const PDF = `${PAPER}/paper.pdf`;
const SAVED = "# Notes\n";
const TYPED = "# Notes\n\nx\n";

function makeSink(initial: DocTab[]) {
	let tabs = initial;
	const updateTabs = vi.fn((update: (prev: DocTab[]) => DocTab[]) => {
		tabs = update(tabs);
	});
	return { getTabs: () => tabs, updateTabs };
}

function notesTab(overrides: Partial<DocTab> = {}): DocTab {
	return {
		...createPlaceholderTab(NOTES, "markdown"),
		loaded: true,
		notesPath: NOTES,
		notesSeed: SAVED,
		notesDirty: true,
		notesKey: 3,
		markdownSeed: "",
		markdownDirty: false,
		seedKey: 1,
		...overrides,
	};
}

function paperTab(): DocTab {
	return {
		...createPlaceholderTab(PDF, "pdf"),
		loaded: true,
		notesPath: NOTES,
		notesSeed: SAVED,
		notesDirty: false,
		notesKey: 3,
		pdfBytes: new ArrayBuffer(4),
	};
}

describe("applyDiskChange notes editors", () => {
	beforeEach(() => {
		readVaultFileMock.mockReset();
		vi.mocked(notifyUndo).mockClear();
		clearWikiVaultState();
		vi.stubGlobal("window", {
			setTimeout: (cb: () => void, ms?: number) => setTimeout(cb, ms),
		});
	});

	it("keeps unsaved notes when a clean paper tab sees the same file change", async () => {
		const sink = makeSink([paperTab(), notesTab()]);
		readVaultFileMock.mockResolvedValue(TYPED);

		await applyDiskChange(NOTES, sink);

		const note = sink.getTabs().find((tab) => tab.path === NOTES);
		expect(note?.notesKey).toBe(3);
		expect(note?.notesSeed).toBe(SAVED);
		expect(note?.seedKey).toBe(1);
		expect(notifyUndo).toHaveBeenCalledTimes(1);
	});

	it("ignores the watcher echo of the body this app just wrote", async () => {
		const sink = makeSink([paperTab(), notesTab()]);
		trackSelfWrittenPath(NOTES, TYPED);
		readVaultFileMock.mockResolvedValue(TYPED);

		await applyDiskChange(NOTES, sink);

		const note = sink.getTabs().find((tab) => tab.path === NOTES);
		expect(note?.notesKey).toBe(3);
		expect(note?.notesSeed).toBe(SAVED);
		expect(sink.updateTabs).not.toHaveBeenCalled();
		expect(notifyUndo).not.toHaveBeenCalled();
	});

	it("reloads a clean notes editor when the file changed outside the app", async () => {
		const sink = makeSink([paperTab(), notesTab({ notesDirty: false })]);
		readVaultFileMock.mockResolvedValue(TYPED);

		await applyDiskChange(NOTES, sink);

		const note = sink.getTabs().find((tab) => tab.path === NOTES);
		expect(note?.notesSeed).toBe(TYPED);
		expect(note?.notesDirty).toBe(false);
		expect(note?.notesKey).toBe(4);
		expect(notifyUndo).not.toHaveBeenCalled();
	});

	it("refreshes a closed notes seed from the open paper tab", async () => {
		const paper = {
			...createPlaceholderTab(PAPER, "pdf"),
			loaded: true,
			notesPath: NOTES,
			notesSeed: SAVED,
			notesDirty: false,
			notesKey: 2,
		};
		const sink = makeSink([paper]);
		readVaultFileMock.mockResolvedValue(TYPED);

		await applyDiskChange(NOTES, sink);

		expect(sink.getTabs()[0]?.notesSeed).toBe(TYPED);
		expect(sink.getTabs()[0]?.notesKey).toBe(3);
		expect(notifyUndo).not.toHaveBeenCalled();
	});
});

describe("markdownDiskConflicts", () => {
	it("treats this window's last write as the editor snapshot catching up", () => {
		expect(markdownDiskConflicts("saved", "saved", undefined)).toBe(false);
		expect(markdownDiskConflicts("written", "stale", "written")).toBe(false);
		expect(markdownDiskConflicts("external", "stale", "written")).toBe(true);
		expect(markdownDiskConflicts("external", "stale", undefined)).toBe(true);
	});
});
