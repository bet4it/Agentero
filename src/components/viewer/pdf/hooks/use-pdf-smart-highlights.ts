import type { Rect } from "@embedpdf/models";
import type { FormattedSelection } from "@embedpdf/plugin-selection/react";
import type { TFunction } from "i18next";
import { useCallback, useEffect, useState } from "react";
import type { PdfHighlights } from "@/components/viewer/pdf/hooks/use-pdf-highlights";
import type { SuggestedHighlight } from "@/components/viewer/pdf/types";
import { commands, events } from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { callApiResult } from "@/lib/core/ipc";
import { notifyError } from "@/lib/core/notify";
import { normalizeHighlightColor } from "@/lib/pdf/highlight/palette";

/** Smart-highlight job submission, result application, and subscription lifetime. */
export function usePdfSmartHighlights({
	vaultPath,
	paperRelPath,
	createHighlights,
	t,
}: {
	vaultPath: string | null;
	paperRelPath: string | null;
	createHighlights: PdfHighlights["createHighlights"];
	t: TFunction<"viewer">;
}) {
	const applyJevHighlights = useCallback(
		(highlights: SuggestedHighlight[]) => {
			for (const h of highlights) {
				const width = h.pageWidth ?? 0;
				const height = h.pageHeight ?? 0;
				if (!width || !height || !h.rects.length) continue;
				const segmentRects: Rect[] = h.rects
					.map((r) => {
						const x = r.x ?? 0;
						const y = r.y ?? 0;
						const w = r.w ?? 0;
						const h_ = r.h ?? 0;
						return {
							origin: { x: x * width, y: y * height },
							size: { width: w * width, height: h_ * height },
						};
					})
					.filter((r) => r.size.width > 0 && r.size.height > 0);
				const first = segmentRects[0];
				const rect: Rect = segmentRects.slice(1).reduce(
					(acc, r) => ({
						origin: {
							x: Math.min(acc.origin.x, r.origin.x),
							y: Math.min(acc.origin.y, r.origin.y),
						},
						size: {
							width:
								Math.max(
									acc.origin.x + acc.size.width,
									r.origin.x + r.size.width,
								) - Math.min(acc.origin.x, r.origin.x),
							height:
								Math.max(
									acc.origin.y + acc.size.height,
									r.origin.y + r.size.height,
								) - Math.min(acc.origin.y, r.origin.y),
						},
					}),
					first,
				);
				const selection: FormattedSelection = {
					pageIndex: h.page - 1,
					rect,
					segmentRects,
				};
				createHighlights(
					[selection],
					normalizeHighlightColor(h.color),
					h.quote,
				);
			}
		},
		[createHighlights],
	);

	const [jevJobId, setJevJobId] = useState<string | null>(null);
	const smartHighlightBusy = jevJobId != null;

	useEffect(() => {
		if (!jevJobId) return;
		let active = true;
		const unlistenPromise = events.jobChanged.listen((event) => {
			if (!active) return;
			const job = event.payload.job;
			if (job.id !== jevJobId || job.kind !== "jevSmartHighlights") return;
			if (job.state === "succeeded") {
				const result = (
					job.params as {
						result?: { highlights?: SuggestedHighlight[] };
					} | null
				)?.result;
				const highlights = result?.highlights ?? [];
				applyJevHighlights(highlights);
				setJevJobId(null);
			} else if (job.state === "failed" || job.state === "cancelled") {
				const raw = job.error?.trim();
				const message =
					raw === "jevNoReadableText"
						? t("pdf.jevNoReadableText")
						: raw || t("pdf.smartHighlightFailed");
				notifyError(message);
				setJevJobId(null);
			}
		});
		return () => {
			active = false;
			void unlistenPromise.then((dispose) => dispose());
		};
	}, [jevJobId, applyJevHighlights, t]);

	const handleSmartHighlight = useCallback(async () => {
		if (!vaultPath || !paperRelPath) return;
		try {
			const snapshot = await callApiResult(() =>
				commands.jobJevSmartHighlightsEnqueue({
					vaultPath,
					path: paperRelPath,
				}),
			);
			setJevJobId(snapshot.id);
		} catch (err) {
			notifyError(errorText(err));
		}
	}, [vaultPath, paperRelPath]);

	return { smartHighlightBusy, handleSmartHighlight };
}
