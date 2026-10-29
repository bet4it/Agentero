// Adapted from Better Auth UI 1.7.32 (MIT). See THIRD_PARTY.md.
"use client";

import { Trash2 } from "lucide-react";
import { useState } from "react";
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogMedia,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/features/account/primitives/alert-dialog";
import { Button, buttonVariants } from "@/features/account/primitives/button";
import { Spinner } from "@/features/account/primitives/spinner";

export function OrganizationTableBulkAction({
	actionLabel,
	cancelLabel,
	count,
	description,
	disabled,
	isPending,
	onConfirm,
	selectedLabel,
}: {
	actionLabel: string;
	cancelLabel: string;
	count: number;
	description: string;
	disabled?: boolean;
	isPending: boolean;
	onConfirm: () => Promise<void>;
	selectedLabel: string;
}) {
	const [open, setOpen] = useState(false);

	return (
		<div className="flex flex-wrap items-center gap-2">
			<span className="text-muted-foreground text-sm tabular-nums">
				{selectedLabel.replace("{{count}}", String(count))}
			</span>
			<AlertDialog
				open={open}
				onOpenChange={(nextOpen) => !isPending && setOpen(nextOpen)}
			>
				<AlertDialogTrigger
					className={buttonVariants({ size: "sm", variant: "destructive" })}
					disabled={disabled || count === 0}
				>
					<Trash2 data-icon="inline-start" />
					{actionLabel}
				</AlertDialogTrigger>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogMedia>
							<Trash2 />
						</AlertDialogMedia>
						<AlertDialogTitle>{actionLabel}</AlertDialogTitle>
						<AlertDialogDescription>{description}</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={isPending}>
							{cancelLabel}
						</AlertDialogCancel>
						<Button
							disabled={isPending}
							onClick={async () => {
								await onConfirm();
								setOpen(false);
							}}
							variant="destructive"
						>
							{isPending && <Spinner data-icon="inline-start" />}
							{actionLabel}
						</Button>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
