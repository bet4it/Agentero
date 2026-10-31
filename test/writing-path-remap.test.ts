import { beforeEach, describe, expect, it } from "vitest";
import { createPathRemapper } from "@/lib/core/path";
import { remapWritingPaths, writingStore } from "@/lib/writing/store";

describe("remapWritingPaths", () => {
	beforeEach(() => {
		writingStore.setState({
			vaultPath: null,
			activeRoot: "/vault/thesis/paper/main.tex",
			activeFile: "/vault/thesis/paper/sections/intro.tex",
			openFiles: [
				"/vault/thesis/paper/main.tex",
				"/vault/thesis/paper/sections/intro.tex",
				"/vault/thesis/paper/other.tex",
			],
			recents: ["/vault/thesis/paper/main.tex"],
		});
	});

	it("moves open files when their folder is moved", () => {
		remapWritingPaths([
			{
				from: "/vault/thesis/paper/sections",
				to: "/vault/thesis/paper/chapters",
			},
		]);
		const state = writingStore.getState();
		expect(state.activeFile).toBe("/vault/thesis/paper/chapters/intro.tex");
		expect(state.openFiles).toEqual([
			"/vault/thesis/paper/main.tex",
			"/vault/thesis/paper/chapters/intro.tex",
			"/vault/thesis/paper/other.tex",
		]);
	});

	it("follows a moved project root and keeps recents in sync", () => {
		remapWritingPaths([
			{
				from: "/vault/thesis/paper/main.tex",
				to: "/vault/thesis/renamed/main.tex",
			},
		]);
		const state = writingStore.getState();
		expect(state.activeRoot).toBe("/vault/thesis/renamed/main.tex");
		expect(state.recents).toEqual(["/vault/thesis/renamed/main.tex"]);
	});
});

describe("createPathRemapper", () => {
	it("normalizes Windows moves but preserves unmatched paths and directory boundaries", () => {
		const remap = createPathRemapper([
			{ from: "C:/Vault/Paper/", to: "D:/Work/New/" },
		]);
		expect(remap(String.raw`c:\vault\paper\Main.tex`)).toBe(
			"D:/Work/New/Main.tex",
		);
		expect(remap("c:/vault/paper")).toBe("D:/Work/New");
		const unmatched = String.raw`C:\Vault\Paperwork\Main.tex`;
		expect(remap(unmatched)).toBe(unmatched);
	});

	it("uses the first matching move without chaining through later moves", () => {
		const remap = createPathRemapper([
			{ from: "/vault/old", to: "/vault/new" },
			{ from: "/vault/old/main.tex", to: "/vault/specific.tex" },
			{ from: "/vault/new", to: "/vault/final" },
		]);
		expect(remap("/vault/old/main.tex")).toBe("/vault/new/main.tex");
	});
});
