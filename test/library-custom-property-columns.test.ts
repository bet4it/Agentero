import { describe, expect, it, vi } from "vitest";
import { getColumnMeta } from "@/components/library/library-columns";
import { customPropertiesStore } from "@/lib/paper/custom-properties-store";

vi.mock("@/lib/core/tauri", () => ({
	isTauri: () => false,
	isMacOS: () => false,
	isMobileApp: () => false,
	getPlatformOS: () => "other",
}));

function property(id: string, type: "select" | "text") {
	return {
		id,
		name: id,
		type,
		orderIndex: 0,
		options: [],
		createdAt: "t",
		updatedAt: "t",
	};
}

const paper = {
	path: "papers/x",
	id: "x",
	type: "arxiv",
	title: "X",
	authors: [],
	tags: [],
	status: "completed",
	is_read: false,
	added_at: "",
	updated_at: "",
};

type El = { type: unknown; props: Record<string, unknown> };

describe("custom property column dispatch", () => {
	it("renders the editor that matches the property type", () => {
		customPropertiesStore.setState({
			properties: [property("p_select", "select"), property("p_text", "text")],
			loading: false,
		});

		const select = getColumnMeta("prop:p_select").render(
			paper,
			{} as never,
		) as El;
		const text = getColumnMeta("prop:p_text").render(paper, {} as never) as El;

		// Both wrap the editor in a `<td>`; only the editor differs.
		expect(select.type).toBe("td");
		expect(text.type).toBe("td");
		const selectChild = select.props.children as El;
		const textChild = text.props.children as El;
		expect((selectChild.type as { name: string }).name).toBe("SelectCell");
		expect((textChild.type as { name: string }).name).toBe("TextCell");
		expect((textChild.props.property as { id: string }).id).toBe("p_text");

		customPropertiesStore.setState({ properties: [], loading: false });
	});

	it("falls back to a placeholder when the definition is gone", () => {
		customPropertiesStore.setState({ properties: [], loading: false });
		const cell = getColumnMeta("prop:missing").render(paper, {} as never) as El;
		expect(cell.type).toBe("td");
		expect(cell.props.children).toBe("—");
	});
});
