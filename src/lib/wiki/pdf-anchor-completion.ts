import { paperAbsFromWikiTarget } from "@/lib/pdf/annotation-ref";
import {
	type DocumentAnchor,
	documentAnchors,
} from "@/lib/pdf/layout/document-anchors";
import {
	readLayoutSidecar,
	subscribeLayoutSidecarWrite,
} from "@/lib/pdf/layout/io";
import type { WikiSearchCandidate } from "@/lib/wiki/api";

function stripHash(anchor: string): string {
	return anchor.startsWith("#") ? anchor.slice(1) : anchor;
}

function sectionLabel(item: DocumentAnchor, anchor: string): string {
	const title = item.title?.trim();
	if (title) return title;
	const text = item.text?.trim();
	return text || anchor;
}

/** "2.3 Related Work" → "Related Work". The number stays on the first line. */
function sectionTitle(label: string, number: string): string {
	const trimmed = label.trim();
	const escaped = number.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const withoutNumber = trimmed
		.replace(new RegExp(`^${escaped}(?:\\.|:|\\))?\\s*`), "")
		.trim();
	if (withoutNumber && withoutNumber !== trimmed) return withoutNumber;
	const withoutRoman = trimmed
		.replace(/^(?:[IVXLCDM]+\s*)+(?:\.|:|\))?\s+/iu, "")
		.trim();
	if (withoutRoman && withoutRoman !== trimmed) return withoutRoman;
	return trimmed;
}

/**
 * Ancestor names for a dotted section, each followed by `>`.
 * `2.3` under "2 Related Work" is `Related Work >`.
 */
function sectionPrefix(
	number: string,
	titles: ReadonlyMap<string, string>,
): string | undefined {
	const parts = number.split(".");
	if (parts.length < 2) return undefined;
	const names: string[] = [];
	for (let index = 1; index < parts.length; index += 1) {
		const parent = parts.slice(0, index).join(".");
		const label = titles.get(parent);
		if (!label) continue;
		const title = sectionTitle(label, parent);
		if (title) names.push(title);
	}
	if (!names.length) return undefined;
	return `${names.join(" > ")} >`;
}

function matchesSection(
	anchor: string,
	title: string,
	filter: string,
): boolean {
	if (!filter) return true;
	const normalizedAnchor = anchor.toLowerCase();
	const normalizedTitle = title.toLowerCase();
	if (/^[\d.]+$/.test(filter)) {
		return (
			normalizedAnchor === filter ||
			normalizedAnchor.startsWith(`${filter}.`) ||
			normalizedTitle.startsWith(filter)
		);
	}
	return (
		normalizedAnchor.startsWith(filter) || normalizedTitle.includes(filter)
	);
}

/**
 * Heading candidates for `[[file.pdf#…]]`. An empty query lists numbered
 * sections. `2#` lists that section's paragraphs (`2#p1`). Section numbers
 * come from the layout sidecar, not Markdown headings.
 */
export function pdfHeadingCandidates(
	pdfRelPath: string,
	query: string,
	anchors: readonly DocumentAnchor[],
): WikiSearchCandidate[] {
	const hash = query.indexOf("#");
	if (hash < 0) {
		const filter = query.trim().toLowerCase();
		const titles = new Map<string, string>();
		for (const item of anchors) {
			if (item.kind !== "section" || !item.anchor) continue;
			const anchor = stripHash(item.anchor);
			titles.set(anchor, sectionLabel(item, anchor));
		}
		const sections: WikiSearchCandidate[] = [];
		for (const [anchor, label] of titles) {
			if (!matchesSection(anchor, label, filter)) continue;
			sections.push({
				kind: "heading",
				path: pdfRelPath,
				insertText: `${pdfRelPath}#${anchor}`,
				label,
				detail: sectionPrefix(anchor, titles),
				pdfSection: true,
				fragment: { kind: "heading", path: [anchor] },
			});
		}
		return sections;
	}
	const section = query.slice(0, hash).trim();
	const filter = query
		.slice(hash + 1)
		.trim()
		.toLowerCase();
	const sectionAnchor = `#${section}`;
	const paragraphs: WikiSearchCandidate[] = [];
	for (const item of anchors) {
		if (
			item.kind !== "paragraph" ||
			!item.anchor ||
			item.sectionAnchor !== sectionAnchor
		) {
			continue;
		}
		const anchor = stripHash(item.anchor);
		const text = item.text?.trim() || anchor;
		const ordinal = anchor.slice(anchor.lastIndexOf("#") + 1);
		if (
			filter &&
			!ordinal.startsWith(filter) &&
			!text.toLowerCase().includes(filter)
		) {
			continue;
		}
		paragraphs.push({
			kind: "heading",
			path: pdfRelPath,
			insertText: `${pdfRelPath}#${anchor}`,
			label: text,
			detail: anchor,
			fragment: { kind: "heading", path: anchor.split("#") },
		});
	}
	return paragraphs;
}

function paperCacheKey(paperAbs: string): string {
	return paperAbs.replaceAll("\\", "/").replace(/\/+$/, "");
}

const anchorsByPaper = new Map<string, DocumentAnchor[]>();

subscribeLayoutSidecarWrite((paperAbs) => {
	anchorsByPaper.delete(paperCacheKey(paperAbs));
});

async function anchorsForPdf(
	vaultPath: string,
	pdfRelPath: string,
): Promise<DocumentAnchor[]> {
	const paperAbs = paperAbsFromWikiTarget(vaultPath, pdfRelPath);
	const key = paperCacheKey(paperAbs);
	const cached = anchorsByPaper.get(key);
	if (cached) return cached;
	const sidecar = await readLayoutSidecar(paperAbs);
	const anchors = sidecar ? documentAnchors(sidecar.regions) : [];
	anchorsByPaper.set(key, anchors);
	return anchors;
}

/** Read `{paper}/source/layout.json` and list section or paragraph headings. */
export async function loadPdfHeadingCandidates(input: {
	vaultPath: string;
	pdfRelPath: string;
	query: string;
}): Promise<WikiSearchCandidate[]> {
	if (!input.pdfRelPath.toLowerCase().endsWith(".pdf")) return [];
	const anchors = await anchorsForPdf(input.vaultPath, input.pdfRelPath);
	return pdfHeadingCandidates(input.pdfRelPath, input.query, anchors);
}
