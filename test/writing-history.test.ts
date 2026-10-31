import { describe, expect, it } from "vitest";
import { stepPdfZoom } from "@/lib/pdf/zoom";
import {
	contentHash,
	HISTORY_COALESCE_MS,
	HISTORY_LIMIT,
	type HistoryEntry,
	historyProjectKey,
	planSnapshot,
} from "@/lib/writing/history";
import { writingHistoryProjectRel } from "@/lib/writing/session";

function entry(
	partial: Partial<HistoryEntry> & Pick<HistoryEntry, "id" | "rel" | "hash">,
): HistoryEntry {
	return { at: 1_000, bytes: partial.hash.length, ...partial };
}

describe("writing history", () => {
	it("keeps a nested project and the shelf apart", () => {
		expect(
			writingHistoryProjectRel(
				"D:/vault",
				"D:/vault/thesis/paper/sections/a.tex",
			),
		).toBe("thesis/paper");
		expect(
			writingHistoryProjectRel("D:/vault", "D:/vault/thesis/main.tex"),
		).toBe("thesis");
		expect(writingHistoryProjectRel("D:/vault", "D:/vault/notes/a.md")).toBe(
			null,
		);
	});

	it("skips an unchanged file and coalesces a quick edit", () => {
		const hash = contentHash("abc");
		const first = entry({ id: "a", rel: "main.tex", hash, at: 5_000 });
		expect(planSnapshot([first], "main.tex", "abc", 6_000, "b").action).toBe(
			"skip",
		);
		const next = planSnapshot([first], "main.tex", "abcd", 6_000, "b");
		expect(next).toMatchObject({
			action: "write",
			replace: true,
			entry: { id: "a", rel: "main.tex" },
		});
	});

	it("appends after the window, and a restore does not erase the last snapshot", () => {
		const first = entry({ id: "a", rel: "main.tex", hash: "h:3", at: 5_000 });
		const later = planSnapshot(
			[first],
			"main.tex",
			"abcd",
			5_000 + HISTORY_COALESCE_MS,
			"b",
		);
		expect(later).toMatchObject({
			action: "write",
			replace: false,
			entry: { id: "b" },
		});
		const forced = planSnapshot([first], "main.tex", "abcd", 5_100, "c", true);
		expect(forced).toMatchObject({
			action: "write",
			replace: false,
			entry: { id: "c" },
		});
	});

	it("drops the oldest snapshot past the cap", () => {
		const entries = Array.from({ length: HISTORY_LIMIT }, (_, index) =>
			entry({
				id: `id-${index}`,
				rel: "main.tex",
				hash: `h:${index}`,
				at: index,
			}),
		);
		const plan = planSnapshot(entries, "chap.tex", "new", 10_000, "fresh");
		expect(plan.action).toBe("write");
		if (plan.action !== "write") return;
		expect(plan.entries).toHaveLength(HISTORY_LIMIT);
		expect(plan.dropIds).toEqual(["id-0"]);
		expect(plan.entries[0]?.id).toBe("id-1");
		expect(plan.entries.at(-1)?.id).toBe("fresh");
	});

	it("builds a stable project key", () => {
		expect(historyProjectKey("D:/vault/thesis/paper")).toBe(
			historyProjectKey("D:\\vault\\thesis\\paper"),
		);
	});

	it("keeps PDF zoom within its supported steps", () => {
		expect(stepPdfZoom(1, 1)).toBe(1.1);
		expect(stepPdfZoom(0.5, -1)).toBe(0.5);
	});
});
