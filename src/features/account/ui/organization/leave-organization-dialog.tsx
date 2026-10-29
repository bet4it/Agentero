// Adapted from Better Auth UI 1.7.32 (MIT). See THIRD_PARTY.md.
"use client";

import type { OrganizationAuthClient } from "@better-auth-ui/core/plugins/organization";
import { useAuth, useAuthPlugin } from "@better-auth-ui/react";
import type { Organization } from "better-auth/client";
import { LogOut } from "lucide-react";
import { toast } from "sonner";
import { useLeaveOrganization } from "@/features/account/data";
import { organizationPlugin } from "@/features/account/organization-plugin";
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogMedia,
	AlertDialogTitle,
} from "@/features/account/primitives/alert-dialog";
import { Button } from "@/features/account/primitives/button";
import { Card, CardContent } from "@/features/account/primitives/card";
import { Spinner } from "@/features/account/primitives/spinner";
import { OrganizationView } from "./organization-view";

export type LeaveOrganizationDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	organization: Organization;
};

export function LeaveOrganizationDialog({
	open,
	onOpenChange,
	organization,
}: LeaveOrganizationDialogProps) {
	const { authClient, basePaths, localization, navigate } =
		useAuth<OrganizationAuthClient>();
	const {
		localization: organizationLocalization,
		viewPaths: organizationPluginViewPaths,
	} = useAuthPlugin(organizationPlugin);

	const { mutate: leaveOrganization, isPending } = useLeaveOrganization(
		authClient,
		{
			onSuccess: async () => {
				onOpenChange(false);
				toast.success(organizationLocalization.leftOrganization);

				await navigate({
					to: `${basePaths.settings}/${organizationPluginViewPaths.settings.organizations}`,
					replace: true,
				});
			},
		},
	);

	return (
		<AlertDialog open={open} onOpenChange={onOpenChange}>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogMedia className="bg-destructive/10 text-destructive">
						<LogOut />
					</AlertDialogMedia>

					<AlertDialogTitle>
						{organizationLocalization.leaveOrganization}
					</AlertDialogTitle>

					<AlertDialogDescription>
						{organizationLocalization.leaveOrganizationDescription}
					</AlertDialogDescription>
				</AlertDialogHeader>

				<Card>
					<CardContent>
						<OrganizationView organization={organization} hideRole />
					</CardContent>
				</Card>

				<AlertDialogFooter>
					<AlertDialogCancel disabled={isPending}>
						{localization.settings.cancel}
					</AlertDialogCancel>

					<Button
						variant="destructive"
						disabled={isPending}
						onClick={() =>
							leaveOrganization({ organizationId: organization.id })
						}
					>
						{isPending && <Spinner />}

						{organizationLocalization.leaveOrganization}
					</Button>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
