// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TextCell } from "@/components/library/text-cell";

const setPaperCustomProperty = vi.fn(async () => true);

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/lib/paper/custom-properties-store", () => ({
	setPaperCustomProperty: (...args: unknown[]) =>
		setPaperCustomProperty(...args),
}));

const property = {
	id: "prop_note",
	name: "Lab Note",
	type: "text",
	orderIndex: 0,
	options: [],
	createdAt: "t",
	updatedAt: "t",
};

let root: Root;
let container: HTMLDivElement;

function render(value: string | undefined) {
	return act(async () =>
		root.render(
			createElement(
				"table",
				null,
				createElement(
					"tbody",
					null,
					createElement(
						"tr",
						null,
						createElement(TextCell, {
							paperPath: "papers/x",
							property,
							value,
						}),
					),
				),
			),
		),
	);
}

const input = () => container.querySelector("input");
const cellButton = () => container.querySelector("button");

function type(value: string) {
	const el = input()!;
	const setter = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value",
	)?.set;
	setter?.call(el, value);
	el.dispatchEvent(new Event("input", { bubbles: true }));
}

function key(name: string) {
	input()!.dispatchEvent(
		new KeyboardEvent("keydown", { key: name, bubbles: true }),
	);
}

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	setPaperCustomProperty.mockClear();
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	document.body.replaceChildren();
	vi.unstubAllGlobals();
});

describe("TextCell", () => {
	it("commits the trimmed text on Enter and closes the editor", async () => {
		await render(undefined);
		await act(async () =>
			cellButton()!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
		);
		expect(input()).not.toBeNull();

		await act(async () => {
			type("  see §3  ");
			key("Enter");
		});
		expect(setPaperCustomProperty).toHaveBeenCalledWith(
			"papers/x",
			"prop_note",
			"see §3",
		);
		expect(input()).toBeNull();
	});

	it("clears the value when the committed text is blank", async () => {
		await render("old");
		await act(async () =>
			cellButton()!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
		);
		await act(async () => {
			type("   ");
			key("Enter");
		});
		expect(setPaperCustomProperty).toHaveBeenCalledWith(
			"papers/x",
			"prop_note",
			null,
		);
	});

	it("reverts on Escape and skips the write when nothing changed", async () => {
		await render("keep me");
		await act(async () =>
			cellButton()!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
		);
		await act(async () => {
			type("discard");
			key("Escape");
		});
		expect(setPaperCustomProperty).not.toHaveBeenCalled();
		expect(container.textContent).toContain("keep me");

		// Reopening and pressing Enter without an edit is also a no-op.
		await act(async () =>
			cellButton()!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
		);
		await act(async () => key("Enter"));
		expect(setPaperCustomProperty).not.toHaveBeenCalled();
	});
});
