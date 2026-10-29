import { Crown } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useTransferOwnership } from "@/features/account/data";
import { apiErrorMessage } from "@/features/account/errors";
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/features/account/primitives/alert-dialog";
import { Button } from "@/features/account/primitives/button";

/** Thin UI for the atomic operation not provided by Better Auth UI. */
export function TransferOwnership({
	organizationId,
	userId,
	name,
}: {
	organizationId: string;
	userId: string;
	name: string;
}) {
	const { t } = useTranslation("account");
	const [open, setOpen] = useState(false);
	const transfer = useTransferOwnership(organizationId);
	return (
		<>
			<Button
				variant="ghost"
				size="icon"
				aria-label={t("org.transferOwnership")}
				onClick={() => setOpen(true)}
			>
				<Crown />
			</Button>
			<AlertDialog
				open={open}
				onOpenChange={(value) => {
					if (!transfer.isPending) setOpen(value);
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{t("org.transferOwnership")}</AlertDialogTitle>
						<AlertDialogDescription>
							{t("org.transferDescription", { name })}
						</AlertDialogDescription>
					</AlertDialogHeader>
					{transfer.isError && (
						<p role="alert" className="text-sm text-destructive">
							{apiErrorMessage(t, transfer.error)}
						</p>
					)}
					<AlertDialogFooter>
						<AlertDialogCancel disabled={transfer.isPending}>
							{t("common.cancel")}
						</AlertDialogCancel>
						<Button
							disabled={transfer.isPending}
							onClick={() =>
								transfer.mutate(userId, {
									onSuccess: () => {
										setOpen(false);
										toast.success(t("org.transferSuccess"));
									},
								})
							}
						>
							{t("org.transferOwnership")}
						</Button>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
