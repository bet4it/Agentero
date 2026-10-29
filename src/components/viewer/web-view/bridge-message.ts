/**
 * Wire contract of the `agentero-web` selection bridge (injected by
 * `features/web/proxy.rs` into every proxied document).
 *
 * Frame → app messages carry `source: "agentero-web"`; the reverse direction
 * (`use-web-view-selection` → frame) carries `source: "agentero-web-host"`.
 * Parsing lives here so both the listener hook and tests share one guard.
 */

/** Keyboard state forwarded for authoritative matching against live settings. */
export type WebBridgeKeyEvent = Pick<
	KeyboardEvent,
	"key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
>;

/** Selection rect in the frame's viewport (CSS px). */
export type WebBridgeRect = {
	x: number;
	y: number;
	width: number;
	height: number;
};

export type WebBridgeMessage =
	| {
			type: "selection";
			text: string;
			rect: WebBridgeRect | null;
			url: string;
	  }
	| { type: "scroll" }
	| { type: "ready" }
	| { type: "shortcut"; event: WebBridgeKeyEvent }
	| { type: "external"; url: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Narrow a `MessageEvent.data` into a bridge message (null when foreign). */
export function parseWebBridgeMessage(data: unknown): WebBridgeMessage | null {
	if (!isRecord(data) || data.source !== "agentero-web") return null;
	switch (data.type) {
		case "selection": {
			if (typeof data.text !== "string" || typeof data.url !== "string")
				return null;
			const raw = data.rect;
			let rect: WebBridgeRect | null = null;
			if (isRecord(raw)) {
				const { x, y, width, height } = raw;
				if (
					typeof x === "number" &&
					typeof y === "number" &&
					typeof width === "number" &&
					typeof height === "number"
				) {
					rect = { x, y, width, height };
				}
			}
			return { type: "selection", text: data.text, rect, url: data.url };
		}
		case "ready":
			return { type: "ready" };
		case "scroll":
			return { type: "scroll" };
		case "shortcut": {
			const event = data.event;
			if (
				!isRecord(event) ||
				typeof event.key !== "string" ||
				typeof event.code !== "string" ||
				typeof event.metaKey !== "boolean" ||
				typeof event.ctrlKey !== "boolean" ||
				typeof event.altKey !== "boolean" ||
				typeof event.shiftKey !== "boolean"
			)
				return null;
			const { key, code, metaKey, ctrlKey, altKey, shiftKey } = event;
			return {
				type: "shortcut",
				event: { key, code, metaKey, ctrlKey, altKey, shiftKey },
			};
		}
		case "external":
			return typeof data.url === "string"
				? { type: "external", url: data.url }
				: null;
		default:
			return null;
	}
}

/**
 * Anchor point (top-center of the selection) in app viewport coordinates:
 * frame-viewport rect + the iframe element's offset in the page.
 */
export function bridgeSelectionScreen(
	rect: WebBridgeRect,
	iframeRect: { x: number; y: number },
): { x: number; y: number } {
	return {
		x: iframeRect.x + rect.x + rect.width / 2,
		y: iframeRect.y + rect.y,
	};
}

/**
 * Bottom-right corner of the selection in app viewport coordinates. Translate
 * cards anchor here so they open below-right of the selected text instead of
 * on top of its first lines (a cross-paragraph selection's bounding rect
 * reaches far down the page, making a top anchor cover body text).
 */
export function bridgeSelectionBottomRight(
	rect: WebBridgeRect,
	iframeRect: { x: number; y: number },
): { x: number; y: number } {
	return {
		x: iframeRect.x + rect.x + rect.width,
		y: iframeRect.y + rect.y + rect.height,
	};
}
