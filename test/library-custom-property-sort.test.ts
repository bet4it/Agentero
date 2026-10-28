import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildPaperRow,
	comparePaperRows,
} from "@/components/library/library-row-utils";
import type { PaperLibraryRow } from "@/lib/paper";
import { customPropertiesStore } from "@/lib/paper/custom-properties-store";

vi.mock("@/lib/core/tauri", () => ({
	isTauri: () => false,
	isMacOS: () => false,
	isMobileApp: () => false,
	getPlatformOS: () => "other",
}));

function property(
	id: string,
	type: "select" | "text",
	options: { id: string; name: string }[] = [],
) {
	return {
		id,
		name: id,
		type,
		orderIndex: 0,
		options,
		createdAt: "t",
		updatedAt: "t",
	};
}

function paper(
	id: string,
	custom_props: Record<string, string>,
): PaperLibraryRow {
	return {
		path: `papers/${id}`,
		id,
		type: "arxiv",
		title: id,
		authors: [],
		tags: [],
		status: "completed",
		is_read: false,
		added_at: "",
		updated_at: "",
		custom_props,
	};
}

describe("custom property sort keys", () => {
	afterEach(() => {
		customPropertiesStore.setState({ properties: [], loading: false });
	});

	it("sorts select columns by option name and text columns by raw text", () => {
		customPropertiesStore.setState({
			properties: [
				property("p_status", "select", [
					{ id: "opt_done", name: "Done" },
					{ id: "opt_todo", name: "Todo" },
				]),
				property("p_note", "text"),
			],
			loading: false,
		});
		const rows = [
			paper("a", { p_status: "opt_todo", p_note: "zebra" }),
			paper("b", { p_status: "opt_done", p_note: "alpha" }),
			// Text values are free-form: a missing value must not crash the sort.
			paper("c", {}),
		].map(buildPaperRow);

		// Select values are option ids, but the sort key is the visible label.
		expect(rows[0].sort["prop:p_status"]).toBe("todo");
		expect(rows[1].sort["prop:p_status"]).toBe("done");
		expect(rows[2].sort["prop:p_status"]).toBe("");

		expect(
			rows
				.slice()
				.sort((x, y) => comparePaperRows(x, y, "prop:p_note", "asc"))
				.map((r) => r.paper.id),
		).toEqual(["c", "b", "a"]);
	});
});
