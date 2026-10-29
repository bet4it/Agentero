// Adapted from Better Auth UI 1.7.32 (MIT). See THIRD_PARTY.md.
"use client";

import type { OrganizationAuthClient } from "@better-auth-ui/core/plugins/organization";
import { useAuth, useAuthPlugin } from "@better-auth-ui/react";
import type { Organization } from "better-auth/client";
import { TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { useDeleteOrganization } from "@/features/account/data";
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
import { Card, CardContent } from "@/features/account/primitives/card";
import { useAuthForm } from "../auth-form";
import { OrganizationView } from "./organization-view";

export type DeleteOrganizationDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	organization: Organization;
};

export function DeleteOrganizationDialog({
	open,
	onOpenChange,
	organization,
}: DeleteOrganizationDialogProps) {
	const { authClient, basePaths, localization, navigate } =
		useAuth<OrganizationAuthClient>();
	const {
		localization: organizationLocalization,
		viewPaths: organizationPluginViewPaths,
	} = useAuthPlugin(organizationPlugin);

	const { mutateAsync: deleteOrganization, isPending } = useDeleteOrganization(
		authClient,
		{
			onSuccess: async () => {
				onOpenChange(false);
				toast.success(organizationLocalization.organizationDeleted);

				await navigate({
					to: `${basePaths.settings}/${organizationPluginViewPaths.settings.organizations}`,
					replace: true,
				});
			},
		},
	);

	const form = useAuthForm({
		defaultValues: {},
		onSubmit: async () => {
			await deleteOrganization({ organizationId: organization.id });
		},
	});

	return (
		<AlertDialog open={open} onOpenChange={onOpenChange}>
			<AlertDialogContent>
				<form.AppForm>
					<form.AuthFormRoot className="flex flex-col gap-6">
						<AlertDialogHeader>
							<AlertDialogMedia className="bg-destructive/10 text-destructive">
								<TriangleAlert />
							</AlertDialogMedia>

							<AlertDialogTitle>
								{organizationLocalization.deleteOrganization}
							</AlertDialogTitle>

							<AlertDialogDescription>
								{organizationLocalization.deleteOrganizationDescription}
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

							<form.AuthFormSubmitButton
								isPending={isPending}
								variant="destructive"
								disabled={isPending}
							>
								{organizationLocalization.deleteOrganization}
							</form.AuthFormSubmitButton>
						</AlertDialogFooter>
					</form.AuthFormRoot>
				</form.AppForm>
			</AlertDialogContent>
		</AlertDialog>
	);
}
