// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { WikiAttachmentEmbed } from "@/components/editor/embeds/wiki-attachment-embed";
import type { PdfViewerProps } from "@/components/viewer/pdf/types";
import type { CitationTarget } from "@/lib/agent/api";

const mocks = vi.hoisted(() => ({
	resolve: vi.fn(),
	notify: vi.fn(),
	t: (key: string) => key,
}));
vi.mock("react-i18next", async (importOriginal) => ({
	...(await importOriginal<typeof import("react-i18next")>()),
	useTranslation: () => ({ t: mocks.t }),
}));
vi.mock("@/lib/agent/api", () => ({ resolvePdfCitation: mocks.resolve }));
vi.mock("@/lib/core/notify", () => ({ notifyError: mocks.notify }));
vi.mock("@/lib/paper/media", () => ({
	localFileToArrayBuffer: async () => new ArrayBuffer(8),
	findLocalPdfPath: async (root: string) => `${root}/demo.pdf`,
}));
vi.mock("@/components/viewer", () => ({
	PdfViewer: (props: PdfViewerProps) =>
		createElement("div", {
			"data-doc": props.docId,
			"data-target": props.embeddedTarget?.region?.id,
			"data-paper": props.paperAbsPath,
			"data-paper-rel": props.paperRelPath,
			"data-vault": props.vaultPath,
			"data-plain": props.plainViewer,
			"data-pdf-path": props.pdfPath,
			"data-remember": props.rememberReadingPosition,
		}),
}));

afterEach(() => {
	vi.clearAllMocks();
	vi.unstubAllGlobals();
});

const props = {
	kind: "pdf" as const,
	absoluteTarget: "/vault/papers/demo/demo.pdf",
	targetPath: "papers/demo/demo.pdf",
	vaultPath: "/vault",
	revision: 0,
};
const citation = (id: string): CitationTarget => ({
	paperPath: "papers/demo",
	path: props.targetPath,
	fragment: "2.1#p3",
	pageIndex: 2,
	regionId: id,
	bbox: { x: 0.55, y: 0.3, w: 0.35, h: 0.1 },
});

it("resolves canonical and legacy PDF embeds independently and preserves their targets on rerender", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	mocks.resolve
		.mockResolvedValueOnce(citation("paragraph"))
		.mockResolvedValueOnce(citation("heading"));
	const container = document.createElement("div");
	const root = createRoot(container);
	const embeds = () =>
		createElement(
			"div",
			null,
			createElement(WikiAttachmentEmbed, {
				...props,
				fragment: { kind: "heading", path: ["2.1", "p3"] },
			}),
			createElement(WikiAttachmentEmbed, {
				...props,
				fragment: { kind: "heading", path: ["section=2.1"] },
			}),
			createElement(WikiAttachmentEmbed, props),
		);
	try {
		await act(() => root.render(embeds()));
		expect(mocks.resolve.mock.calls).toEqual([
			["/vault", `${props.targetPath}#2.1#p3`],
			["/vault", `${props.targetPath}#section=2.1`],
		]);
		const viewers = [...container.querySelectorAll("[data-doc]")];
		for (const viewer of viewers) {
			expect(viewer.getAttribute("data-paper")).toBe("/vault/papers/demo");
			expect(viewer.getAttribute("data-paper-rel")).toBe("papers/demo");
			expect(viewer.getAttribute("data-vault")).toBe("/vault");
			expect(viewer.getAttribute("data-plain")).toBe("false");
			expect(viewer.getAttribute("data-pdf-path")).toBe(props.absoluteTarget);
			expect(viewer.getAttribute("data-remember")).toBe("false");
		}
		expect(viewers.map((el) => el.getAttribute("data-target"))).toEqual([
			"paragraph",
			"heading",
			null,
		]);
		expect(new Set(viewers.map((el) => el.getAttribute("data-doc"))).size).toBe(
			3,
		);
		await act(() => root.render(embeds()));
		expect(mocks.resolve).toHaveBeenCalledTimes(2);
		expect(container.querySelector('[data-target="paragraph"]')).not.toBeNull();
	} finally {
		await act(() => root.unmount());
	}
});

it("does not attach the primary PDF's marks to a supplementary PDF", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const container = document.createElement("div");
	const root = createRoot(container);
	try {
		await act(() =>
			root.render(
				createElement(WikiAttachmentEmbed, {
					...props,
					absoluteTarget: "/vault/papers/demo/attachments/supp.pdf",
					targetPath: "papers/demo/attachments/supp.pdf",
				}),
			),
		);
		const viewer = container.querySelector("[data-doc]");
		expect(viewer?.getAttribute("data-paper")).toBeNull();
		expect(viewer?.getAttribute("data-plain")).toBe("true");
	} finally {
		await act(() => root.unmount());
	}
});

it("ignores stale resolution after switching targets and reports a missing target instead of showing another block", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	let finishOld!: (target: CitationTarget) => void;
	mocks.resolve
		.mockReturnValueOnce(
			new Promise<CitationTarget>((resolve) => {
				finishOld = resolve;
			}),
		)
		.mockResolvedValueOnce(citation("new"))
		.mockRejectedValueOnce(new Error("missing paragraph"));
	const container = document.createElement("div");
	const root = createRoot(container);
	const embed = (anchor: string) =>
		createElement(WikiAttachmentEmbed, {
			...props,
			fragment: { kind: "heading", path: [anchor] },
		});
	try {
		await act(() => root.render(embed("2.1")));
		await act(() => root.render(embed("2.2")));
		expect(container.querySelector('[data-target="new"]')).not.toBeNull();
		await act(() => finishOld(citation("old")));
		expect(container.querySelector('[data-target="new"]')).not.toBeNull();
		await act(() => root.render(embed("99")));
		expect(container.querySelector("[data-doc]")).toBeNull();
		expect(container.textContent).toBe("embed.error");
		expect(mocks.notify).toHaveBeenCalledOnce();
	} finally {
		await act(() => root.unmount());
	}
});
