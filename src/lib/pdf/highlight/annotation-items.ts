import {
	type PdfAnnotationObject,
	PdfAnnotationSubtype,
} from "@embedpdf/models";
import type { AnnotationTransferItem } from "@embedpdf/plugin-annotation";

/** Native links without /NM get a fresh id on every PDFium open. */
function linkContentKey(item: AnnotationTransferItem): string | null {
	if (item.annotation?.type !== PdfAnnotationSubtype.LINK || item.ctx != null)
		return null;
	const { id: _id, ...annotation } = item.annotation;
	// Ignore only the link's transient id. Keep target ids, styles and metadata.
	// Entries with transfer context are always preserved.
	return JSON.stringify({ ...item, annotation }, (_key, value) => {
		if (!value || typeof value !== "object" || Array.isArray(value))
			return value;
		return Object.fromEntries(
			Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
		);
	});
}

/** Compact exact link copies as well as repeated ids, without mutating input. */
export function dedupeAnnotationItems(
	items: readonly AnnotationTransferItem[],
	existing: readonly PdfAnnotationObject[] = [],
): AnnotationTransferItem[] {
	const ids = new Set(existing.map((annotation) => annotation.id));
	const links = new Set(
		existing
			.map((annotation) => linkContentKey({ annotation }))
			.filter((key): key is string => key !== null),
	);
	const result: AnnotationTransferItem[] = [];
	for (const item of items) {
		const id = item.annotation?.id;
		if (id && ids.has(id)) continue;
		const key = linkContentKey(item);
		if (key !== null && links.has(key)) continue;
		if (id) ids.add(id);
		if (key !== null) links.add(key);
		result.push(item);
	}
	return result;
}
