const SCROLLING_CLASS = "scrolling";
const HIDE_DELAY_MS = 800;
const TIMEOUT_KEY = Symbol("agentero-scrollbar-timeout");

function handleScroll(event: Event) {
	const target = event.target;
	if (!(target instanceof Element)) return;

	const classes = target.classList;
	if (
		!classes.contains("agentero-scroll") &&
		!classes.contains("agentero-scroll-both")
	) {
		return;
	}

	classes.add(SCROLLING_CLASS);
	const previous = (target as HTMLElement & { [TIMEOUT_KEY]?: number })[
		TIMEOUT_KEY
	];
	if (previous) {
		window.clearTimeout(previous);
	}

	(target as HTMLElement & { [TIMEOUT_KEY]?: number })[TIMEOUT_KEY] =
		window.setTimeout(() => {
			classes.remove(SCROLLING_CLASS);
		}, HIDE_DELAY_MS);
}

/**
 * Mark `<html data-overlay-scrollbars>` when scrollbars float over content
 * (WebKitGTK / macOS) instead of reserving layout space (Windows WebView2).
 * index.css hides overlay scrollbars while a tooltip or menu is open; doing
 * that with classic scrollbars would reflow the page on every hover.
 */
function markOverlayScrollbars() {
	const probe = document.createElement("div");
	probe.style.cssText =
		"position:absolute;top:-9999px;width:100px;height:100px;overflow:scroll";
	document.body.appendChild(probe);
	const overlay = probe.offsetWidth === probe.clientWidth;
	probe.remove();
	document.documentElement.toggleAttribute("data-overlay-scrollbars", overlay);
}

export function initAutoHideScrollbars() {
	if (typeof document === "undefined") return;

	markOverlayScrollbars();

	document.addEventListener("scroll", handleScroll, {
		capture: true,
		passive: true,
	});
}
