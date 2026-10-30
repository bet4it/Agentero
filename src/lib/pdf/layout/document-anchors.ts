import { documentReadingOrder } from "./document-reading-order";
import type { DocumentAnchorRegion } from "./types";

/**
 * Numbered PDF sections and the paragraphs they own.
 *
 * Mirrors `enumerate_document_anchors` / `document_anchors` / `section_number`
 * in `crates/agentero-core/src/features/pdf/layout_index.rs`. Completion and
 * citation must agree on `#2`, `#2.1` and `#2#p1`, including reading order
 * and ambiguous duplicate section numbers.
 */

export type { DocumentAnchorRegion } from "./types";

export type DocumentAnchor = {
	id: string;
	kind: "section" | "paragraph";
	/** `#2` or `#2#p1`. Null when the owning section number is ambiguous. */
	anchor: string | null;
	/** `#2`. Null after an unnumbered header. */
	sectionAnchor: string | null;
	title?: string;
	text?: string;
	paragraphIndex?: number;
};

const ROMAN = [
	"i",
	"ii",
	"iii",
	"iv",
	"v",
	"vi",
	"vii",
	"viii",
	"ix",
	"x",
	"xi",
	"xii",
	"xiii",
	"xiv",
	"xv",
	"xvi",
	"xvii",
	"xviii",
	"xix",
	"xx",
];

function romanNumber(marker: string): string | null {
	const index = ROMAN.indexOf(marker.toLowerCase());
	return index >= 0 ? String(index + 1) : null;
}

/**
 * Explicit Arabic hierarchy or an IEEE Roman top-level marker. A numeric
 * substring is not a section (`2` is not `2.1`, `12` or an arXiv id).
 */
export function sectionNumber(title: string): string | null {
	const trimmed = title.trimStart();
	let numeric = "";
	for (const char of trimmed) {
		if ((char >= "0" && char <= "9") || char === ".") numeric += char;
		else break;
	}
	const number = numeric.replace(/\.+$/, "");
	const boundary = trimmed.slice(numeric.length);
	if (
		number.length > 0 &&
		(boundary.length === 0 ||
			/^\s/u.test(boundary) ||
			boundary.startsWith(":") ||
			boundary.startsWith(")") ||
			numeric.endsWith(".")) &&
		number.split(".").every((part) => part.length > 0 && /^\d+$/.test(part))
	) {
		return number
			.split(".")
			.map((part) => String(Number(part)))
			.join(".");
	}
	const compact = trimmed.replace(/\s+/g, "");
	const dot = compact.indexOf(".");
	if (dot >= 0) {
		const fromCompact = romanNumber(compact.slice(0, dot));
		if (fromCompact) return fromCompact;
	}
	const first = trimmed.split(/\s+/)[0];
	if (!first) return null;
	return romanNumber(first.replace(/[.:)]+$/g, ""));
}

function headerLabel(region: DocumentAnchorRegion): string | undefined {
	const title = region.title?.trim();
	if (title) return title;
	const text = region.text?.trim();
	return text || undefined;
}

/** Numbered headings and directly owned body blocks, before any score filter. */
export function documentAnchors(
	regions: readonly DocumentAnchorRegion[],
): DocumentAnchor[] {
	const items: DocumentAnchor[] = [];
	let sectionAnchor: string | null = null;
	let paragraphIndex = 0;
	for (const region of documentReadingOrder(regions)) {
		if (region.kind === "header") {
			const number = sectionNumber(headerLabel(region) ?? "");
			sectionAnchor = number ? `#${number}` : null;
			paragraphIndex = 0;
			items.push({
				id: region.id,
				kind: "section",
				anchor: sectionAnchor,
				sectionAnchor,
				title: region.title,
				text: region.text,
			});
			continue;
		}
		const body = region.text?.trim();
		if (
			(region.kind === "text" || region.kind === "paragraph") &&
			body &&
			sectionAnchor
		) {
			paragraphIndex += 1;
			items.push({
				id: region.id,
				kind: "paragraph",
				anchor: `${sectionAnchor}#p${paragraphIndex}`,
				sectionAnchor,
				title: region.title,
				text: region.text,
				paragraphIndex,
			});
		}
	}
	const counts = new Map<string, number>();
	for (const item of items) {
		if (item.kind === "section" && item.anchor) {
			counts.set(item.anchor, (counts.get(item.anchor) ?? 0) + 1);
		}
	}
	for (const item of items) {
		if (item.sectionAnchor && (counts.get(item.sectionAnchor) ?? 0) > 1) {
			item.anchor = null;
		}
	}
	return items;
}
