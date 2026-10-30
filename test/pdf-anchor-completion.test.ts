import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	documentAnchors,
	sectionNumber,
} from "@/lib/pdf/layout/document-anchors";
import {
	parseWikiCompletionQuery,
	wikiCompletionHeadingForSubmit,
	wikiCompletionInsert,
	wikiCompletionUsesPdfHint,
	wikiTabContinuesCompletion,
	wikiTabKeepsSourceDraft,
} from "@/lib/wiki/completion";
import { pdfHeadingCandidates } from "@/lib/wiki/pdf-anchor-completion";
import {
	parseWikiLinkMarkdown,
	wikiLinkToMarkdown,
} from "@/lib/wiki/wikilink-model";

import easySteer from "./fixtures/pdf-paragraph-anchors/easysteer-layout.json";
import readingOrderCases from "./fixtures/pdf-paragraph-anchors/reading-order-cases.json";

const fixture = JSON.parse(
	readFileSync(
		join(
			dirname(fileURLToPath(import.meta.url)),
			"fixtures/pdf-paragraph-anchors/layout.json",
		),
		"utf8",
	),
) as { regions: Parameters<typeof documentAnchors>[0] };

describe("sectionNumber", () => {
	it("matches the host's Arabic and Roman markers", () => {
		expect(sectionNumber("2 Method")).toBe("2");
		expect(sectionNumber("2.1 Method")).toBe("2.1");
		expect(sectionNumber("2.Method")).toBe("2");
		expect(sectionNumber("III.Method")).toBe("3");
		expect(sectionNumber("III. Results")).toBe("3");
		expect(sectionNumber("I I I. Method")).toBe("3");
		expect(sectionNumber("I Preliminaries (e.g. notation)")).toBe("1");
		expect(sectionNumber("Introduction")).toBeNull();
		expect(sectionNumber("arXiv:2504.16054v1")).toBeNull();
	});
});

describe("documentAnchors", () => {
	it.each([
		easySteer,
		...readingOrderCases,
	])("repairs column ownership for $source.generatedAt", (layout) => {
		const anchors = documentAnchors(layout.regions);
		expect(
			Object.fromEntries(anchors.map((item) => [item.id, item.anchor])),
		).toEqual(layout.expectedAnchors);
		// Enumeration must not depend on sidecar array order or mutate it.
		expect(documentAnchors([...layout.regions].reverse())).toEqual(anchors);
	});

	it("completes EasySteer 4.2.1 with the model-wrapper paragraphs", () => {
		const candidates = pdfHeadingCandidates(
			"2509.25175.pdf",
			"4.2.1#",
			documentAnchors(easySteer.regions),
		);
		expect(candidates.map((item) => item.detail)).toEqual([
			"4.2.1#p1",
			"4.2.1#p2",
		]);
		expect(candidates[0]?.label).toMatch(
			/^Direct modification of diverse LLM architectures/,
		);
		expect(candidates[1]?.label).toMatch(/^Our dynamic wrapping mechanism/);
	});

	it("numbers paragraphs in reading order under each section", () => {
		const anchors = documentAnchors(fixture.regions).map((item) => ({
			id: item.id,
			anchor: item.anchor,
		}));
		expect(anchors).toEqual([
			{ id: "h2", anchor: "#2" },
			{ id: "body-1", anchor: "#2#p1" },
			{ id: "body-2", anchor: "#2#p2" },
			{ id: "h21", anchor: "#2.1" },
			{ id: "body-21", anchor: "#2.1#p1" },
			{ id: "h3", anchor: "#3" },
			{ id: "body-3", anchor: "#3#p1" },
		]);
	});

	it("drops anchors when the same section number occurs twice", () => {
		const anchors = documentAnchors([
			{
				id: "h1",
				pageIndex: 0,
				kind: "header",
				text: "2 Method",
				readingOrder: 0,
			},
			{
				id: "p1",
				pageIndex: 0,
				kind: "text",
				text: "body",
				readingOrder: 1,
			},
			{
				id: "h2",
				pageIndex: 1,
				kind: "header",
				text: "2 Other",
				readingOrder: 0,
			},
		]);
		expect(anchors.every((item) => item.anchor === null)).toBe(true);
	});
});

describe("pdf heading completion", () => {
	const pdf = "papers/demo/demo.pdf";
	const anchors = documentAnchors(fixture.regions);

	it("parses a PDF hash as a heading query", () => {
		expect(parseWikiCompletionQuery("2509.25175.pdf#")).toEqual({
			kind: "heading",
			target: "2509.25175.pdf",
			query: "",
		});
		expect(parseWikiCompletionQuery("2509.25175.pdf#2#")).toEqual({
			kind: "heading",
			target: "2509.25175.pdf",
			query: "2#",
		});
		expect(parseWikiCompletionQuery("2509.25175.pdf#2#p1")).toEqual({
			kind: "heading",
			target: "2509.25175.pdf",
			query: "2#p1",
		});
	});

	it("lists section names, then that section's paragraphs", () => {
		const sections = pdfHeadingCandidates(pdf, "", anchors);
		expect(sections.map((item) => item.label)).toEqual([
			"2 Method",
			"2.1 Details",
			"III. Results",
		]);
		expect(sections.map((item) => item.detail)).toEqual([
			undefined,
			"Method >",
			undefined,
		]);
		expect(sections.every((item) => item.pdfSection)).toBe(true);

		expect(
			pdfHeadingCandidates(pdf, "2", anchors).map((item) => item.detail),
		).toEqual([undefined, "Method >"]);

		const paragraphs = pdfHeadingCandidates(pdf, "2#", anchors);
		expect(paragraphs.map((item) => item.detail)).toEqual(["2#p1", "2#p2"]);
		expect(paragraphs.map((item) => item.fragment)).toEqual([
			{ kind: "heading", path: ["2", "p1"] },
			{ kind: "heading", path: ["2", "p2"] },
		]);
		expect(
			pdfHeadingCandidates(pdf, "2.1#", anchors).map((item) => item.detail),
		).toEqual(["2.1#p1"]);
	});

	it("shows the parent section title as the second line", () => {
		const nested = documentAnchors([
			{
				id: "h2",
				pageIndex: 0,
				kind: "header",
				text: "2 Related Work",
				readingOrder: 0,
			},
			{
				id: "h23",
				pageIndex: 0,
				kind: "header",
				text: "2.3 xxx",
				readingOrder: 1,
			},
		]);
		const sections = pdfHeadingCandidates(pdf, "", nested);
		expect(sections.map((item) => item.label)).toEqual([
			"2 Related Work",
			"2.3 xxx",
		]);
		expect(sections.map((item) => item.detail)).toEqual([
			undefined,
			"Related Work >",
		]);
	});

	it("tabs from a section into paragraph completion and stops after a paragraph", () => {
		const section = pdfHeadingCandidates(pdf, "", anchors)[0];
		expect(section).toBeDefined();
		if (!section) return;
		const inserted = wikiCompletionInsert(section, {
			kind: "heading",
			target: "demo.pdf",
			query: "",
		});
		expect(
			wikiCompletionHeadingForSubmit(inserted, section, "Tab").heading,
		).toBe("2#");
		expect(
			wikiCompletionHeadingForSubmit(inserted, section, "Enter").heading,
		).toBe("2");
		const continued = wikiLinkToMarkdown({
			value: "2509.25175.pdf",
			heading: wikiCompletionHeadingForSubmit(inserted, section, "Tab").heading,
		});
		expect(continued).toBe("[[2509.25175.pdf#2#]]");
		expect(parseWikiLinkMarkdown(continued)).toBeNull();
		expect(wikiTabKeepsSourceDraft(continued)).toBe(true);
		expect(
			wikiTabKeepsSourceDraft(
				wikiLinkToMarkdown({
					value: "2509.25175.pdf",
					heading: "2",
				}),
			),
		).toBe(false);
		expect(
			wikiCompletionUsesPdfHint(
				{ kind: "file", query: "2509.25175.pdf" },
				null,
			),
		).toBe(true);
		expect(
			wikiCompletionUsesPdfHint(
				{ kind: "heading", target: "2509.25175.pdf", query: "" },
				null,
			),
		).toBe(true);
		expect(
			wikiCompletionUsesPdfHint({ kind: "file", query: "NOTES" }, null),
		).toBe(false);
		expect(
			wikiCompletionUsesPdfHint(
				{ kind: "heading", target: "NOTES", query: "Intro" },
				null,
			),
		).toBe(false);
		expect(
			wikiTabContinuesCompletion(section, {
				kind: "heading",
				target: "demo.pdf",
				query: "2#",
			}),
		).toBe(true);

		const paragraph = pdfHeadingCandidates(pdf, "2#", anchors)[0];
		expect(paragraph).toBeDefined();
		if (!paragraph) return;
		expect(
			wikiTabContinuesCompletion(paragraph, {
				kind: "heading",
				target: "demo.pdf",
				query: "2#p1",
			}),
		).toBe(false);
		expect(
			wikiCompletionInsert(paragraph, {
				kind: "heading",
				target: "demo.pdf",
				query: "2#",
			}).heading,
		).toBe("2#p1");
	});
});
