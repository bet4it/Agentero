// Adapted from Better Auth UI 1.7.32 (MIT). See THIRD_PARTY.md.
"use client";

import type { OrganizationAuthClient } from "@better-auth-ui/core/plugins/organization";
import { useAuth, useAuthPlugin } from "@better-auth-ui/react";
import { useRemoveMember } from "@better-auth-ui/react/plugins/organization";
import type { Member, User } from "better-auth/client";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
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
import { Badge } from "@/features/account/primitives/badge";
import { Button } from "@/features/account/primitives/button";
import { Card, CardContent } from "@/features/account/primitives/card";
import { Spinner } from "@/features/account/primitives/spinner";
import { UserView } from "../user/user-view";

export type RemoveMemberDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	member: Member & { user: Partial<User> };
};

export function RemoveMemberDialog({
	open,
	onOpenChange,
	member,
}: RemoveMemberDialogProps) {
	const { authClient, localization } = useAuth<OrganizationAuthClient>();
	const { localization: organizationLocalization, roles } =
		useAuthPlugin(organizationPlugin);

	const { mutate: removeMember, isPending } = useRemoveMember(authClient, {
		onSuccess: () => {
			onOpenChange(false);
			toast.success(organizationLocalization.memberRemoved);
		},
	});

	return (
		<AlertDialog open={open} onOpenChange={onOpenChange}>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogMedia className="bg-destructive/10 text-destructive">
						<Trash2 />
					</AlertDialogMedia>

					<AlertDialogTitle>
						{organizationLocalization.removeMember}
					</AlertDialogTitle>

					<AlertDialogDescription>
						{organizationLocalization.removeMemberWarning}
					</AlertDialogDescription>
				</AlertDialogHeader>

				<Card>
					<CardContent className="flex flex-row items-center justify-between gap-2">
						<UserView user={member.user} />

						<Badge variant="outline">
							{roles?.[member.role] ?? member.role}
						</Badge>
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
							removeMember({
								memberIdOrEmail: member.id,
								organizationId: member.organizationId,
							})
						}
					>
						{isPending && <Spinner />}

						{organizationLocalization.removeMember}
					</Button>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
