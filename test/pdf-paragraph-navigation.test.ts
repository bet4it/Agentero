import type { PdfDocumentObject } from "@embedpdf/models";
import type { ScrollScope } from "@embedpdf/plugin-scroll";
import { afterEach, expect, it, vi } from "vitest";
import {
	clearLayoutVaultState,
	layoutAnalysisStore,
	layoutKindFromCitationFragment,
} from "@/lib/pdf/layout/store";
import { scrollToPdfRegion } from "@/lib/pdf/region-navigation";
import layout from "./fixtures/pdf-paragraph-anchors/layout.json";

afterEach(() => {
	clearLayoutVaultState();
	vi.useRealTimers();
});

it("scrolls and flashes the exact paragraph box without expanding a short block into a heading preview", () => {
	vi.useFakeTimers();
	const block = layout.regions.find((region) => region.id === "body-2");
	expect(block).toBeDefined();
	if (!block) throw new Error("missing paragraph fixture");
	const scrollToPage = vi.fn();
	const document = {
		pages: [{ size: { width: 600, height: 800 } }],
	} as unknown as PdfDocumentObject;
	scrollToPdfRegion(
		"paragraph-document",
		{
			id: block.id,
			pageIndex: block.pageIndex,
			bbox: block.bbox,
			kind: layoutKindFromCitationFragment("2#p2"),
		},
		document,
		{ scrollToPage } as unknown as ScrollScope,
	);
	expect(scrollToPage).toHaveBeenCalledWith({
		pageNumber: 1,
		behavior: "instant",
		pageCoordinates: { x: 330, y: 120 },
		alignX: 0,
		alignY: 18,
	});
	const focused = layoutAnalysisStore.getState().focused;
	expect(focused).toMatchObject({
		flash: true,
		region: { bbox: block.bbox, kind: "text" },
	});
	vi.runAllTimers();
	expect(layoutAnalysisStore.getState().focused).toBeNull();
});
