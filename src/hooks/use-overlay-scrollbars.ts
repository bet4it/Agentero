import { OverlayScrollbars } from "overlayscrollbars";
import { type RefObject, useEffect } from "react";

/**
 * Draws a pane's scrollbars with OverlayScrollbars on top of an existing
 * native scroller. WebKitGTK paints its own overlay scrollbars above every
 * page layer, so tooltips cannot cover them; these are plain DOM elements
 * that stack normally.
 *
 * `viewport` stays the real scroll element (virtualizers, EmbedPDF and scroll
 * listeners keep working); `host` is its wrapper and receives the scrollbars.
 * The library forces `padding: 0` on the viewport through a stylesheet rule,
 * so viewport padding must be set inline.
 */
export function useOverlayScrollbars(
	hostRef: RefObject<HTMLElement | null>,
	viewportRef: RefObject<HTMLElement | null>,
	axis: "vertical" | "both" = "vertical",
) {
	useEffect(() => {
		const host = hostRef.current;
		const viewport = viewportRef.current;
		if (!host || !viewport) return;

		const instance = OverlayScrollbars(
			{ target: host, elements: { viewport }, scrollbars: { slot: host } },
			{
				overflow: { x: axis === "both" ? "scroll" : "hidden" },
				scrollbars: {
					theme: "os-theme-agentero",
					autoHide: "move",
					autoHideDelay: 800,
				},
			},
		);
		return () => instance.destroy();
	}, [hostRef, viewportRef, axis]);
}
