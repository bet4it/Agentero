import {
	useIsViewportGated,
	useViewportCapability,
	useViewportPlugin,
	ViewportElementContext,
} from "@embedpdf/plugin-viewport/react";
import {
	type HTMLAttributes,
	type ReactNode,
	type RefObject,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPdfViewportResizeGate } from "@/lib/pdf/dockview-resize";
import { registerScrollSyncElement } from "@/lib/pdf/scroll-sync";
import { createPdfViewportScrollScheduler } from "@/lib/pdf/viewport-scroll";
import { isDockviewSashTarget } from "@/lib/workspace/dockview-sash";

type DockviewViewportProps = HTMLAttributes<HTMLDivElement> & {
	children: ReactNode;
	documentId: string;
	hostRef: RefObject<HTMLDivElement | null>;
	/**
	 * Extra right padding (px) beyond the viewport gap, reserving room for
	 * overlays pinned outside the page's right edge (comment rail) so they do
	 * not grow scrollWidth into a horizontal scrollbar.
	 */
	rightGutter?: number;
};

/**
 * Dockview updates panel geometry on every sash pointermove. EmbedPDF's
 * ResizeObserver otherwise turns each of those moves into viewport + scroll
 * state updates. Keep the DOM viewport following the panel while resize
 * metrics are gated; releasing the sash lets EmbedPDF observe the final size
 * once.
 */
export function DockviewViewport({
	children,
	documentId,
	hostRef,
	rightGutter = 0,
	...props
}: DockviewViewportProps) {
	const [viewportGap, setViewportGap] = useState(0);
	const viewportRef = useRef<HTMLDivElement>(null);
	const { plugin: viewportPlugin } = useViewportPlugin();
	const { provides: viewportCapability } = useViewportCapability();
	const isGated = useIsViewportGated(documentId);

	useEffect(() => {
		if (viewportCapability) {
			setViewportGap(viewportCapability.getViewportGap());
		}
	}, [viewportCapability]);

	useLayoutEffect(() => {
		const viewport = viewportRef.current;
		if (!viewportPlugin || !viewport) return;

		try {
			viewportPlugin.registerViewport(documentId);
		} catch {
			return;
		}

		// Dual-pane scroll sync reads / writes this element directly so the
		// follower pane does not inherit the scroll-request pipeline's extra
		// animation frame (and so pan-drag writes propagate immediately).
		const unregisterScrollSyncElement = registerScrollSyncElement(
			documentId,
			viewport,
		);

		const ownerDocument = viewport.ownerDocument;
		const ownerWindow = ownerDocument.defaultView;
		const workspace = hostRef.current?.closest(".agentero-dockview") ?? null;
		const requestFrame = (callback: FrameRequestCallback) =>
			ownerWindow
				? ownerWindow.requestAnimationFrame(callback)
				: requestAnimationFrame(callback);
		const cancelFrame = (handle: number) => {
			if (ownerWindow) ownerWindow.cancelAnimationFrame(handle);
			else cancelAnimationFrame(handle);
		};
		const scrollScheduler = createPdfViewportScrollScheduler({
			requestFrame,
			cancelFrame,
			apply: (request) => {
				viewport.scrollTo({
					left: request.x,
					top: request.y,
					behavior: request.behavior,
				});
			},
		});
		const commitResize = () => {
			// Report a reduced width so EmbedPDF's fitWidth zoom leaves room for the
			// comment rail that overflows into the reserved right gutter.
			const width = Math.max(1, viewport.offsetWidth - rightGutter);
			const clientWidth = Math.max(1, viewport.clientWidth - rightGutter);
			viewportPlugin.setViewportResizeMetrics(documentId, {
				width,
				height: viewport.offsetHeight,
				clientWidth,
				clientHeight: viewport.clientHeight,
				scrollTop: viewport.scrollTop,
				scrollLeft: viewport.scrollLeft,
				scrollWidth: viewport.scrollWidth,
				scrollHeight: viewport.scrollHeight,
				clientLeft: viewport.clientLeft,
				clientTop: viewport.clientTop,
			});
		};
		const resizeGate = createPdfViewportResizeGate({
			commitResize,
			requestFrame,
			cancelFrame,
		});
		let dockResizeActive = false;

		const removeEndListeners = () => {
			ownerDocument.removeEventListener("pointerup", finishResize, true);
			ownerDocument.removeEventListener("pointercancel", finishResize, true);
			ownerDocument.removeEventListener("contextmenu", finishResize, true);
			ownerWindow?.removeEventListener("blur", finishResize);
		};

		const finishResize = () => {
			if (!dockResizeActive) return;
			dockResizeActive = false;
			removeEndListeners();
			resizeGate.endDockResize();
		};

		const handlePointerDown = (event: PointerEvent) => {
			if (
				dockResizeActive ||
				!workspace ||
				!isDockviewSashTarget(event.target, workspace)
			) {
				return;
			}

			dockResizeActive = true;
			resizeGate.beginDockResize();
			ownerDocument.addEventListener("pointerup", finishResize, true);
			ownerDocument.addEventListener("pointercancel", finishResize, true);
			ownerDocument.addEventListener("contextmenu", finishResize, true);
			ownerWindow?.addEventListener("blur", finishResize);
		};

		let scrollFrame: number | null = null;
		const handleScroll = () => {
			// Scroll events are not sufficient to identify user input: virtual page
			// reordering, zoom/layout changes, and dual-pane synchronization all
			// write the viewport programmatically. Only the explicit wheel precursor
			// below cancels a deferred request.
			if (scrollFrame != null) return;
			scrollFrame = requestFrame(() => {
				scrollFrame = null;
				viewportPlugin.setViewportScrollMetrics(documentId, {
					scrollTop: viewport.scrollTop,
					scrollLeft: viewport.scrollLeft,
				});
			});
		};
		viewport.addEventListener("scroll", handleScroll, { passive: true });
		// Wheel is an unambiguous user-originated precursor to the native scroll
		// event. Cancel here, before the native scroll event, so the deferred
		// request cannot overwrite the user's new position.
		const handleWheel = () => scrollScheduler.cancelPending();
		viewport.addEventListener("wheel", handleWheel, {
			capture: true,
			passive: true,
		});

		const ResizeObserverCtor = ownerWindow?.ResizeObserver ?? ResizeObserver;
		const resizeObserver = new ResizeObserverCtor(() => {
			resizeGate.notifyResize();
		});
		resizeObserver.observe(viewport);

		const unsubscribeScrollRequest = viewportPlugin.onScrollRequest(
			documentId,
			({ x, y, behavior = "auto" }) =>
				scrollScheduler.schedule({ x, y, behavior }),
		);

		ownerDocument.addEventListener("pointerdown", handlePointerDown, true);
		return () => {
			ownerDocument.removeEventListener("pointerdown", handlePointerDown, true);
			removeEndListeners();
			dockResizeActive = false;
			resizeGate.dispose();
			resizeObserver.disconnect();
			if (scrollFrame != null) cancelFrame(scrollFrame);
			scrollScheduler.dispose();
			viewport.removeEventListener("scroll", handleScroll);
			viewport.removeEventListener("wheel", handleWheel, true);
			unsubscribeScrollRequest();
			unregisterScrollSyncElement();
			viewportPlugin.unregisterViewport(documentId);
		};
	}, [documentId, hostRef, viewportPlugin, rightGutter]);

	const { style, ...restProps } = props;

	return (
		<ViewportElementContext.Provider
			value={viewportRef as RefObject<HTMLDivElement>}
		>
			<div
				{...restProps}
				ref={viewportRef}
				style={{
					width: "100%",
					height: "100%",
					overflow: "auto",
					...style,
					// Scroller swaps virtualized page nodes while scrolling. Letting
					// Chromium's scroll anchoring adjust this custom virtual viewport can
					// move it to an endpoint when the rendered range changes.
					overflowAnchor: "none",
					padding: `${viewportGap}px`,
					// The shorthand above would clobber a caller's paddingRight; merge
					// the reserved rail gutter explicitly.
					paddingRight: `${viewportGap + rightGutter}px`,
				}}
			>
				{!isGated && children}
			</div>
		</ViewportElementContext.Provider>
	);
}
