import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { SelectionCopiedLabel } from "@/components/ui/selection-copied-label";
import { AskPopover } from "@/components/viewer/pdf/cards/ask-popover";
import { SelectionMenu } from "@/components/viewer/pdf/cards/selection-menu";
import { TranslateCard } from "@/components/viewer/pdf/cards/translate-card";
import { useWebViewSelection } from "@/components/viewer/web-view/use-web-view-selection";
import { commands } from "@/lib/core/bindings";
import { callApiResult } from "@/lib/core/ipc";
import { cn } from "@/lib/core/utils";
import { arxivReaderUrl, isArxivHostedUrl } from "@/lib/paper/arxiv";
import { webViewProxyUrl } from "@/lib/web-view/proxy-url";

type HtmlViewerProps = {
	/** Remote URL only — streamed in a sandboxed iframe (no local download) */
	srcUrl?: string | null;
	/** Paper title for ask-card / prompt context. */
	title?: string;
	className?: string;
};

/** Load-state of the built-in proxy for one paper host. */
type ProxyGate = "pending" | "ready" | "denied";

/**
 * HTML paper viewer — remote page in a sandboxed iframe.
 * Does not fetch or cache HTML into the vault.
 *
 * arXiv pages keep their dedicated reader proxy; every other host is served
 * through the generic `agentero-web` proxy (host allowlisted via the Host
 * command first), which injects the selection bridge the toolbar below needs.
 */
export function HtmlViewer({ srcUrl, title, className }: HtmlViewerProps) {
	const { t } = useTranslation("viewer");
	const iframeRef = useRef<HTMLIFrameElement | null>(null);
	/** While HTML5 DnD is active, disable iframe hit-testing so dragover
	 * reaches dockview drop targets (sandboxed iframe swallows drag events). */
	const [dragShield, setDragShield] = useState(false);
	const [gate, setGate] = useState<ProxyGate>("pending");

	useEffect(() => {
		const arm = () => setDragShield(true);
		const disarm = () => setDragShield(false);
		// Capture phase: see tree/OS drags before the event enters the iframe.
		window.addEventListener("dragstart", arm, true);
		window.addEventListener("dragend", disarm, true);
		window.addEventListener("drop", disarm, true);
		return () => {
			window.removeEventListener("dragstart", arm, true);
			window.removeEventListener("dragend", disarm, true);
			window.removeEventListener("drop", disarm, true);
		};
	}, []);

	const remote = srcUrl && /^https?:\/\//i.test(srcUrl) ? srcUrl : null;
	const trusted = remote ? isArxivHostedUrl(remote) : false;

	// Ensure the host may be served before the frame points at the proxy —
	// the proxy answers 403 otherwise.
	useEffect(() => {
		if (!remote || trusted) return;
		let cancelled = false;
		setGate("pending");
		void (async () => {
			let host = "";
			try {
				host = new URL(remote).hostname;
			} catch {
				if (!cancelled) setGate("denied");
				return;
			}
			try {
				const accepted = await callApiResult(() =>
					commands.webProxyAllowHost({ host }),
				);
				if (!cancelled) setGate(accepted ? "ready" : "denied");
			} catch {
				if (!cancelled) setGate("denied");
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [remote, trusted]);

	const selection = useWebViewSelection({
		srcUrl: remote ?? "",
		iframeRef,
		title,
	});

	if (!remote) {
		return (
			<div
				className={cn(
					"flex h-full items-center justify-center p-6 text-center text-muted-foreground text-sm",
					className,
				)}
			>
				{t("html.empty")}
			</div>
		);
	}

	const iframeUrl = trusted
		? arxivReaderUrl(remote)
		: gate === "ready"
			? webViewProxyUrl(remote)
			: null;
	const sandbox =
		"allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox";

	return (
		<div
			className={cn(
				"relative h-full min-h-0 w-full min-w-0 overflow-hidden bg-background",
				className,
			)}
		>
			{iframeUrl ? (
				<iframe
					title={t("html.sandboxTitle")}
					src={iframeUrl}
					sandbox={sandbox}
					referrerPolicy="no-referrer-when-downgrade"
					ref={iframeRef}
					onLoad={selection.onFrameLoad}
					className={cn(
						"absolute inset-0 block h-full w-full border-0 bg-background",
						dragShield && "pointer-events-none",
					)}
					style={{ colorScheme: "light dark" }}
				/>
			) : (
				<div className="flex h-full items-center justify-center p-6 text-center text-muted-foreground text-sm">
					{gate === "denied" ? t("html.denied") : null}
				</div>
			)}
			{iframeUrl && !trusted
				? createPortal(
						<>
							{selection.menu && !selection.ask ? (
								<SelectionMenu
									screen={selection.menu.screen}
									onHighlight={() => undefined}
									onAsk={selection.handleAsk}
									onAddToChat={selection.handleAddToChat}
									onTranslate={selection.handleTranslate}
									showHighlight={false}
								/>
							) : null}
							{selection.copiedLabelPos ? (
								<SelectionCopiedLabel
									x={selection.copiedLabelPos.x}
									y={selection.copiedLabelPos.y}
								/>
							) : null}
							{selection.ask ? (
								<AskPopover
									thread={selection.ask.thread}
									paperTitle={title}
									paperLink={remote}
									screen={selection.ask.screen}
									streaming={selection.streaming}
									error={selection.askError}
									onSend={selection.sendAskQuestion}
									onResend={selection.resendAskQuestion}
									onHide={selection.hideAsk}
									onDelete={selection.deleteAsk}
									onStop={selection.stopAskStreaming}
								/>
							) : null}
							{selection.translateRec && selection.translateScreen ? (
								<TranslateCard
									screen={selection.translateScreen}
									result={selection.translateRec.result ?? ""}
									streaming={selection.translateStreaming}
									error={
										selection.translateError ??
										selection.translateRec.error ??
										null
									}
									onOpenSettings={selection.openTranslateSettings}
									onHide={selection.hideTranslate}
								/>
							) : null}
						</>,
						document.body,
					)
				: null}
		</div>
	);
}
