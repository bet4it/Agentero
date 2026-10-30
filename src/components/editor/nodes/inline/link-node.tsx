"use client";
import type { TElement } from "platejs";
import type { PlateElementProps } from "platejs/react";
import { PlateElement } from "platejs/react";
import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMarkdownDoc } from "@/components/editor/context/markdown-doc-context";
import { ExternalLinkElement } from "@/components/editor/nodes/inline/external-link-popover";
import { linkClassName } from "@/components/editor/nodes/inline/link-styles";
import {
	cleanCitationHref,
	isAgentCitationHref,
	isVaultPdfHref,
} from "@/lib/agent/citation-href";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { cn } from "@/lib/core/utils";
import {
	isVaultLocalMarkdownLink,
	navFromResolvedLink,
	parseWikiHref,
	resolveWikiReference,
	WIKI_HREF_PREFIX,
	wikiFragmentSuffix,
} from "@/lib/wiki";
import { useWikiNav } from "@/lib/wiki/nav-context";
import { openCitation, openHtmlPreviewLink } from "@/lib/workspace/actions";

type LinkEl = TElement & {
	url?: string;
	/** Set on slash/context-menu insert; cleared after the edit popover opens. */
	agenteroEditId?: string;
};

export function LinkElement(props: PlateElementProps) {
	const { t } = useTranslation("editor");
	const { children, element } = props;
	const url = cleanCitationHref((element as LinkEl).url ?? "");
	const wiki = url.startsWith(WIKI_HREF_PREFIX) ? parseWikiHref(url) : null;
	const wikiNav = useWikiNav();
	const markdownDoc = useMarkdownDoc();
	const citationJump =
		!wiki && (isAgentCitationHref(url) || isVaultPdfHref(url));
	const localMarkdown = !wiki && !citationJump && isVaultLocalMarkdownLink(url);
	// Local `.html` destinations open in the right-side HTML preview; the wiki
	// resolver only indexes Markdown, so they need their own branch (#825).
	const localHtml =
		!wiki &&
		!citationJump &&
		/\.html?($|[?#])/i.test(url) &&
		isVaultLocalMarkdownLink(url);

	if (citationJump) {
		return (
			<PlateElement
				{...props}
				as="a"
				className={linkClassName}
				attributes={{
					...props.attributes,
					href: url,
					title: url,
					"data-citation": "pdf",
					onClick: async (event: MouseEvent) => {
						event.preventDefault();
						event.stopPropagation();
						// Resolve local PDF paths relative to the source note before
						// handing the canonical target to the shared citation jumper.
						if (
							isVaultPdfHref(url) &&
							wikiNav?.vaultPath &&
							markdownDoc.filePath
						) {
							try {
								const resolved = await resolveWikiReference(
									wikiNav.vaultPath,
									markdownDoc.filePath,
									url,
									"markdown",
								);
								if (resolved)
									wikiNav.onWikiNavigate(navFromResolvedLink(resolved));
							} catch (error) {
								notifyError(errorText(error));
							}
							return;
						}
						openCitation(url);
					},
				}}
			>
				{children}
			</PlateElement>
		);
	}

	if (wiki) {
		return (
			<PlateElement
				{...props}
				as="a"
				className={cn(
					"cursor-pointer font-medium underline-offset-2 transition-colors",
					wiki.status === "resolved"
						? "text-primary underline decoration-primary/40 hover:decoration-primary"
						: "text-muted-foreground underline decoration-dashed decoration-muted-foreground/60 hover:text-foreground",
				)}
				attributes={{
					...props.attributes,
					href: url,
					title:
						wiki.status === "resolved"
							? (wiki.path ?? wiki.targetRaw)
							: t("missingLink", { target: wiki.targetRaw }),
					"data-wiki": wiki.status === "resolved" ? "ok" : "missing",
					onClick: async (event: MouseEvent) => {
						event.preventDefault();
						event.stopPropagation();
						if (wikiNav?.vaultPath && markdownDoc.filePath) {
							try {
								const fragment = wikiFragmentSuffix(wiki.fragment);
								const resolved = await resolveWikiReference(
									wikiNav.vaultPath,
									markdownDoc.filePath,
									`${wiki.targetRaw}${fragment}`,
								);
								if (resolved) {
									wikiNav.onWikiNavigate(navFromResolvedLink(resolved));
									return;
								}
							} catch {
								// Browser preview has no Host resolver; keep its file-only fallback.
							}
						}
						wikiNav?.onWikiNavigate(wiki);
					},
				}}
			>
				{children}
			</PlateElement>
		);
	}

	if (localHtml) {
		return (
			<PlateElement
				{...props}
				as="a"
				className={linkClassName}
				attributes={{
					...props.attributes,
					href: url,
					title: url,
					onClick: (event: MouseEvent) => {
						event.preventDefault();
						event.stopPropagation();
						void openHtmlPreviewLink(url, markdownDoc.filePath);
					},
				}}
			>
				{children}
			</PlateElement>
		);
	}

	if (localMarkdown) {
		return (
			<PlateElement
				{...props}
				as="a"
				className={linkClassName}
				attributes={{
					...props.attributes,
					href: url,
					onClick: async (event: MouseEvent) => {
						event.preventDefault();
						event.stopPropagation();
						if (!wikiNav?.vaultPath || !markdownDoc.filePath) return;
						try {
							const resolved = await resolveWikiReference(
								wikiNav.vaultPath,
								markdownDoc.filePath,
								url,
								"markdown",
							);
							if (!resolved) return;
							wikiNav.onWikiNavigate(navFromResolvedLink(resolved));
						} catch {
							// Keep the link inert when the Host cannot establish a local target.
						}
					},
				}}
			>
				{children}
			</PlateElement>
		);
	}

	return <ExternalLinkElement {...props} />;
}
