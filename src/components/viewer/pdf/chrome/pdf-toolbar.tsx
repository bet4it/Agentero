import type { PdfEngine } from "@embedpdf/models";
import {
	Clock,
	Download,
	Highlighter,
	Languages,
	Library,
	Loader2,
	ScanSearch,
} from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { PDF_CHROME_CHIP } from "@/components/viewer/pdf/chrome/pdf-chrome-surface";
import { useShortcutLabel } from "@/hooks/use-shortcut-label";
import { cn } from "@/lib/core/utils";

type PdfToolbarProps = {
	onExportTranslatedPdf?: (dual?: boolean) => void;
	regionSelecting: boolean;
	visualCropPending: boolean;
	engine: PdfEngine | null;
	onToggleRegionSelect: () => void;
	layoutTranslateRunning: boolean;
	/** Final corrected preview is still building after items settled. */
	layoutTranslatePreparing?: boolean;
	/** Queued behind layout analysis; plain click cancels the wait. */
	layoutTranslateWaiting?: boolean;
	layoutTranslateActive: boolean;
	layoutTranslateLabel: string;
	onToggleLayoutTranslate: () => void;
	/** True while jEV smart highlights are being generated. */
	smartHighlightBusy?: boolean;
	/** Trigger jEV smart highlighting for the current paper. */
	onSmartHighlight?: () => void;
	/** True when viewing a remote paper that has no local sidecar. */
	isRemotePaper?: boolean;
	/** Import the remote paper into the current vault. */
	onImportToLibrary?: () => void;
	/** True while the import is running. */
	importBusy?: boolean;
};

/** Top-right toolbar: region select, bulk translate. Always visible. */
export const PdfToolbar = memo(function PdfToolbar({
	onExportTranslatedPdf,
	regionSelecting,
	visualCropPending,
	engine,
	onToggleRegionSelect,
	layoutTranslateRunning,
	layoutTranslatePreparing = false,
	layoutTranslateWaiting = false,
	layoutTranslateActive,
	layoutTranslateLabel,
	onToggleLayoutTranslate,
	smartHighlightBusy = false,
	onSmartHighlight,
	isRemotePaper = false,
	onImportToLibrary,
	importBusy = false,
}: PdfToolbarProps) {
	const { t } = useTranslation("viewer");
	const visualShortcut = useShortcutLabel("visualAnnotation");
	const translateShortcut = useShortcutLabel("layoutTranslate");

	const LONG_PRESS_MS = 300;
	const longPressTimerRef = useRef<number | null>(null);
	const longPressTriggeredRef = useRef(false);
	const suppressNextClickRef = useRef(false);
	const [longPressing, setLongPressing] = useState(false);

	const clearLongPressTimer = useCallback(() => {
		if (longPressTimerRef.current != null) {
			clearTimeout(longPressTimerRef.current);
			longPressTimerRef.current = null;
		}
	}, []);

	useEffect(() => clearLongPressTimer, [clearLongPressTimer]);

	const handleTranslatePointerDown = useCallback(
		(event: React.PointerEvent<HTMLButtonElement>) => {
			if (event.button !== 0) return;
			if (layoutTranslateActive || layoutTranslateRunning) return;
			if (layoutTranslateWaiting) return;
			setLongPressing(true);
			longPressTriggeredRef.current = false;
			suppressNextClickRef.current = false;
			longPressTimerRef.current = window.setTimeout(() => {
				longPressTriggeredRef.current = true;
				suppressNextClickRef.current = true;
				setLongPressing(true);
				onToggleLayoutTranslate();
			}, LONG_PRESS_MS);
		},
		[
			layoutTranslateActive,
			layoutTranslateRunning,
			layoutTranslateWaiting,
			onToggleLayoutTranslate,
		],
	);

	const handleTranslatePointerUp = useCallback(
		(event: React.PointerEvent<HTMLButtonElement>) => {
			clearLongPressTimer();
			setLongPressing(false);
			if (event.button !== 0) return;
			if (!longPressTriggeredRef.current) return;
			longPressTriggeredRef.current = false;
			if (layoutTranslateActive || layoutTranslateRunning) {
				onToggleLayoutTranslate();
			}
		},
		[
			clearLongPressTimer,
			layoutTranslateActive,
			layoutTranslateRunning,
			onToggleLayoutTranslate,
		],
	);

	const handleTranslatePointerLeave = useCallback(() => {
		clearLongPressTimer();
		setLongPressing(false);
		if (!longPressTriggeredRef.current) return;
		longPressTriggeredRef.current = false;
		suppressNextClickRef.current = true;
		if (layoutTranslateActive || layoutTranslateRunning) {
			onToggleLayoutTranslate();
		}
	}, [
		clearLongPressTimer,
		layoutTranslateActive,
		layoutTranslateRunning,
		onToggleLayoutTranslate,
	]);

	const handleTranslateClick = useCallback(
		(event: React.MouseEvent<HTMLButtonElement>) => {
			if (suppressNextClickRef.current) {
				event.preventDefault();
				suppressNextClickRef.current = false;
				return;
			}
			onToggleLayoutTranslate();
		},
		[onToggleLayoutTranslate],
	);

	return (
		<div className="pointer-events-none absolute top-2 right-3 z-20 flex origin-top-right items-center gap-1">
			<TooltipProvider delayDuration={200}>
				<div
					data-pdf-chrome
					className={cn(
						"pointer-events-auto flex h-7 select-none items-center gap-0.5 rounded-lg p-0.5",
						PDF_CHROME_CHIP,
					)}
				>
					{onExportTranslatedPdf ? (
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button
									type="button"
									size="icon-xs"
									variant="ghost"
									aria-label={t("pdf.layoutTranslate.exportPdf")}
								>
									<Download className="size-3.5" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent>
								<DropdownMenuItem onSelect={() => onExportTranslatedPdf(false)}>
									{t("pdf.layoutTranslate.exportPdf")}
								</DropdownMenuItem>
								<DropdownMenuItem onSelect={() => onExportTranslatedPdf(true)}>
									{t("pdf.layoutTranslate.exportDualPdf")}
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					) : null}
					{isRemotePaper ? (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									size="icon-xs"
									variant="ghost"
									className="shrink-0 self-center"
									aria-label={t("pdf.importToLibrary")}
									disabled={importBusy}
									onClick={onImportToLibrary}
								>
									{importBusy ? (
										<Loader2 className="size-3.5 animate-spin" aria-hidden />
									) : (
										<Library className="size-3.5" aria-hidden />
									)}
								</Button>
							</TooltipTrigger>
							<TooltipContent side="bottom">
								{t("pdf.importToLibrary")}
							</TooltipContent>
						</Tooltip>
					) : null}
					{!isRemotePaper ? (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									size="icon-xs"
									variant={regionSelecting ? "secondary" : "ghost"}
									className="shrink-0 self-center"
									aria-label={t("pdfExplain.selectRegion")}
									aria-pressed={regionSelecting}
									disabled={visualCropPending || !engine}
									onClick={onToggleRegionSelect}
								>
									<ScanSearch
										className={cn(
											"size-3.5",
											visualCropPending && "animate-pulse",
										)}
									/>
								</Button>
							</TooltipTrigger>
							<TooltipContent side="bottom">
								{regionSelecting
									? t("pdfExplain.cancelRegion")
									: t("pdfExplain.selectRegion")}
								{/* Inverted tooltip: mute via text-background, not muted-foreground. */}
								<span className="ml-2 text-background/70">
									{visualShortcut}
								</span>
							</TooltipContent>
						</Tooltip>
					) : null}
					{!isRemotePaper ? (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									size="icon-xs"
									variant={
										layoutTranslateActive ||
										layoutTranslateWaiting ||
										longPressing
											? "secondary"
											: "ghost"
									}
									className="shrink-0 self-center"
									data-full-text-translate
									aria-label={layoutTranslateLabel}
									aria-pressed={layoutTranslateActive || layoutTranslateWaiting}
									disabled={!engine}
									onPointerDown={handleTranslatePointerDown}
									onPointerUp={handleTranslatePointerUp}
									onPointerLeave={handleTranslatePointerLeave}
									onPointerCancel={handleTranslatePointerLeave}
									onClick={handleTranslateClick}
								>
									{layoutTranslateWaiting ? (
										<Clock className="size-3.5 animate-pulse" aria-hidden />
									) : (layoutTranslateRunning || layoutTranslatePreparing) &&
										!longPressing ? (
										<Loader2 className="size-3.5 animate-spin" aria-hidden />
									) : (
										<Languages className="size-3.5" aria-hidden />
									)}
								</Button>
							</TooltipTrigger>
							<TooltipContent side="bottom">
								{layoutTranslateLabel}
								{/* Inverted tooltip: mute via text-background, not muted-foreground. */}
								<span className="ml-2 text-background/70">
									{translateShortcut}
								</span>
							</TooltipContent>
						</Tooltip>
					) : null}
					{!isRemotePaper && onSmartHighlight ? (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									size="icon-xs"
									variant="ghost"
									className="shrink-0 self-center"
									aria-label={t("pdf.smartHighlight")}
									disabled={!engine || smartHighlightBusy}
									onClick={onSmartHighlight}
								>
									{smartHighlightBusy ? (
										<Loader2 className="size-3.5 animate-spin" aria-hidden />
									) : (
										<Highlighter className="size-3.5" aria-hidden />
									)}
								</Button>
							</TooltipTrigger>
							<TooltipContent side="bottom">
								{t("pdf.smartHighlight")}
							</TooltipContent>
						</Tooltip>
					) : null}
				</div>
			</TooltipProvider>
		</div>
	);
});
