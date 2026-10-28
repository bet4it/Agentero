// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreatePropertyDialog } from "@/components/library/custom-property-dialogs";

const createCustomProperty = vi.fn(async () => null);

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/lib/paper/custom-properties-store", () => ({
	createCustomProperty: (...args: unknown[]) => createCustomProperty(...args),
	deleteCustomProperty: vi.fn(),
	updateCustomProperty: vi.fn(),
}));

let root: Root;
let container: HTMLDivElement;

const buttons = () => [...document.body.querySelectorAll("button")];
const byLabel = (label: string) =>
	buttons().find((b) => b.textContent?.trim() === label);

function setInputValue(value: string) {
	const el = document.body.querySelector("input") as HTMLInputElement;
	const setter = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value",
	)?.set;
	setter?.call(el, value);
	el.dispatchEvent(new Event("input", { bubbles: true }));
}

async function click(el: Element | undefined) {
	await act(async () => {
		el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
}

beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	createCustomProperty.mockClear();
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () =>
		root.render(
			createElement(CreatePropertyDialog, {
				open: true,
				onOpenChange: () => {},
				vaultPath: "/vault",
			}),
		),
	);
});

afterEach(async () => {
	await act(async () => root.unmount());
	document.body.replaceChildren();
	vi.unstubAllGlobals();
});

describe("CreatePropertyDialog", () => {
	it("defaults to Select", async () => {
		await act(async () => setInputValue("Priority"));
		await click(byLabel("common.create"));
		expect(createCustomProperty).toHaveBeenCalledWith(
			"Priority",
			"select",
			[],
			"/vault",
		);
	});

	it("creates a Text property when the Text type is picked", async () => {
		await act(async () => setInputValue("Lab Note"));
		await click(byLabel("papersLibrary.customProperties.typeText"));
		await click(byLabel("common.create"));
		expect(createCustomProperty).toHaveBeenCalledWith(
			"Lab Note",
			"text",
			[],
			"/vault",
		);
	});

	it("keeps Create disabled until a name is typed", async () => {
		expect(byLabel("common.create")?.disabled).toBe(true);
		await act(async () => setInputValue("  "));
		expect(byLabel("common.create")?.disabled).toBe(true);
		await act(async () => setInputValue("Name"));
		expect(byLabel("common.create")?.disabled).toBe(false);
	});
});
