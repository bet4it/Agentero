import { ScrollArea as ScrollAreaPrimitive } from "radix-ui";
import type * as React from "react";

import { cn } from "@/lib/core/utils";

type ScrollAreaProps = React.ComponentProps<typeof ScrollAreaPrimitive.Root> & {
	viewportProps?: React.ComponentProps<typeof ScrollAreaPrimitive.Viewport>;
	scrollbars?: "vertical" | "both";
	variant?: "default" | "pane";
};

function ScrollArea({
	className,
	children,
	viewportProps,
	scrollbars = "vertical",
	variant = "default",
	...props
}: ScrollAreaProps) {
	const pane = variant === "pane";
	return (
		<ScrollAreaPrimitive.Root
			data-slot="scroll-area"
			scrollHideDelay={pane ? 800 : undefined}
			className={cn("relative", pane && "agentero-pane-scroll-area", className)}
			{...props}
		>
			<ScrollAreaPrimitive.Viewport
				{...viewportProps}
				data-slot="scroll-area-viewport"
				className={cn(
					"size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1",
					viewportProps?.className,
				)}
			>
				{children}
			</ScrollAreaPrimitive.Viewport>
			<ScrollBar className={pane ? "agentero-pane-scrollbar" : undefined} />
			{scrollbars === "both" && (
				<ScrollBar
					orientation="horizontal"
					className={pane ? "agentero-pane-scrollbar" : undefined}
				/>
			)}
			<ScrollAreaPrimitive.Corner />
		</ScrollAreaPrimitive.Root>
	);
}

function ScrollBar({
	className,
	orientation = "vertical",
	...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
	return (
		<ScrollAreaPrimitive.ScrollAreaScrollbar
			data-slot="scroll-area-scrollbar"
			data-orientation={orientation}
			orientation={orientation}
			className={cn(
				"flex touch-none p-px transition-colors select-none data-horizontal:h-2.5 data-horizontal:flex-col data-horizontal:border-t data-horizontal:border-t-transparent data-vertical:h-full data-vertical:w-2.5 data-vertical:border-l data-vertical:border-l-transparent",
				className,
			)}
			{...props}
		>
			<ScrollAreaPrimitive.ScrollAreaThumb
				data-slot="scroll-area-thumb"
				className="relative flex-1 rounded-full bg-border"
			/>
		</ScrollAreaPrimitive.ScrollAreaScrollbar>
	);
}

export { ScrollArea, ScrollBar };
