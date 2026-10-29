import { PdfAnnotationSubtype, type PdfLinkAnnoObject } from "@embedpdf/models";
import type { AnnotationTransferItem } from "@embedpdf/plugin-annotation";
import { describe, expect, it } from "vitest";
import { dedupeAnnotationItems } from "@/lib/pdf/highlight/annotation-items";

function link(id: string, pageIndex = 0): AnnotationTransferItem {
	return {
		annotation: {
			id,
			pageIndex,
			type: PdfAnnotationSubtype.LINK,
			rect: { origin: { x: 10, y: 20 }, size: { width: 30, height: 10 } },
			target: { type: "destination", destination: { pageIndex: 2, view: [] } },
			contents: "",
		} as PdfLinkAnnoObject,
	};
}

describe("annotation transfer deduplication", () => {
	it("collapses repeated native links with fresh ids and different key order", () => {
		const original = link("first");
		const { target, ...rest } = link("second").annotation;
		const reordered = { annotation: { target, ...rest } };
		const input = [original, reordered, link("third")];
		expect(dedupeAnnotationItems(input)).toEqual([original]);
		expect(input).toHaveLength(3);
	});

	it("preserves different targets, positions, styles and metadata", () => {
		const items = [link("original"), link("page", 1)];
		for (const patch of [
			{
				target: {
					type: "destination",
					destination: { pageIndex: 3, view: [] },
				},
			},
			{ rect: { origin: { x: 11, y: 20 }, size: { width: 30, height: 10 } } },
			{ strokeColor: "#ff0000" },
			{ contents: "different note" },
			{ custom: { id: "target-reference" } },
		]) {
			const item = link(`different-${items.length}`);
			items.push({
				annotation: { ...item.annotation, ...patch },
			} as AnnotationTransferItem);
		}
		expect(dedupeAnnotationItems(items)).toEqual(items);
	});

	it("preserves transfer contexts without comparing binary data as JSON", () => {
		const items = [link("context-a"), link("context-b")].map((item, i) => ({
			...item,
			ctx: { data: new Uint8Array([i]).buffer, mimeType: "image/png" as const },
		}));
		expect(dedupeAnnotationItems(items)).toEqual(items);
	});

	it("does not collapse separate user highlights at the same position", () => {
		const items = [link("note-one"), link("note-two")].map((item) => ({
			annotation: { ...item.annotation, type: PdfAnnotationSubtype.HIGHLIGHT },
		})) as AnnotationTransferItem[];
		expect(dedupeAnnotationItems(items)).toEqual(items);
		expect(dedupeAnnotationItems([items[0], items[0]])).toEqual([items[0]]);
	});

	it("skips native links already loaded in the current document", () => {
		const native = link("pdfium-id").annotation;
		const imported = link("persisted-id");
		expect(dedupeAnnotationItems([imported], [native])).toEqual([]);
	});

	it("stays bounded across export and reopen instead of accumulating native copies", () => {
		let saved = Array.from({ length: 100 }, (_, index) => link(`old-${index}`));
		for (let open = 0; open < 3; open++) {
			const native = link(`native-${open}`);
			const incoming = dedupeAnnotationItems(saved, [native.annotation]);
			expect(incoming).toHaveLength(0);
			saved = dedupeAnnotationItems([native, ...saved]);
			expect(saved).toHaveLength(1);
		}
	});
});
