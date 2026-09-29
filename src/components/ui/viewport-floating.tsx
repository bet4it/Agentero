"use client";

import type * as React from "react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
	type FloatingSide,
	placeViewportFloating,
	type ViewportFloatingPlacement,
	type ViewportPoint,
} from "@/lib/core/viewport-placement";

type ViewportFloatingProps = Omit<React.ComponentProps<"div">, "style"> & {
	point: ViewportPoint;
	side?: FloatingSide;
	offset?: number;
	edge?: number;
	floatingRef?: React.Ref<HTMLDivElement>;
};

function setRef<T>(ref: React.Ref<T> | undefined, value: T | null) {
	if (typeof ref === "function") {
		ref(value);
	} else if (ref) {
		ref.current = value;
	}
}

function samePlacement(
	previous: ViewportFloatingPlacement | null,
	next: ViewportFloatingPlacement,
) {
	return (
		previous?.left === next.left &&
		previous.top === next.top &&
		previous.maxHeight === next.maxHeight &&
		previous.maxWidth === next.maxWidth &&
		previous.side === next.side
	);
}

/**
 * A body-level floating surface for controls anchored to a screen point.
 * Its measured dimensions, not a guessed menu size, determine edge collision.
 */
export function ViewportFloating({
	point,
	side = "bottom",
	offset = 0,
	edge = 8,
	floatingRef,
	children,
	...props
}: ViewportFloatingProps) {
	const elementRef = useRef<HTMLDivElement>(null);
	const [placement, setPlacement] = useState<ViewportFloatingPlacement | null>(
		null,
	);

	const pointX = point.x;
	const pointY = point.y;

	const updatePlacement = useCallback(() => {
		const element = elementRef.current;
		if (!element) return;
		const rect = element.getBoundingClientRect();
		// Measuring while `visibility: hidden` can yield empty rects; never clear
		// placement before measure or the menu can stick invisible after re-layout
		// (e.g. arrow-key selection changes inside a completion list).
		const next = placeViewportFloating({
			point: { x: pointX, y: pointY },
			element: { height: rect.height, width: rect.width },
			viewport: { height: window.innerHeight, width: window.innerWidth },
			side,
			offset,
			edge,
		});
		setPlacement((previous) =>
			samePlacement(previous, next) ? previous : next,
		);
	}, [edge, offset, pointX, pointY, side]);

	useLayoutEffect(() => {
		updatePlacement();
	}, [updatePlacement]);

	useLayoutEffect(() => {
		const element = elementRef.current;
		if (!element) return;
		const observer = new ResizeObserver(updatePlacement);
		observer.observe(element);
		window.addEventListener("resize", updatePlacement);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", updatePlacement);
		};
	}, [updatePlacement]);

	if (typeof document === "undefined") return null;

	return createPortal(
		<div
			{...props}
			// Hides page overlay scrollbars while open (index.css).
			data-viewport-floating=""
			ref={(element) => {
				elementRef.current = element;
				setRef(floatingRef, element);
			}}
			style={{
				left: placement?.left ?? point.x,
				maxHeight: placement?.maxHeight ?? `calc(100vh - ${edge * 2}px)`,
				maxWidth: placement?.maxWidth ?? `calc(100vw - ${edge * 2}px)`,
				overflowX: "hidden",
				overflowY: "auto",
				position: "fixed",
				top: placement?.top ?? point.y,
				visibility: placement ? "visible" : "hidden",
			}}
		>
			{children}
		</div>,
		document.body,
	);
}
