// Adapted from Better Auth UI 1.7.32 (MIT). See THIRD_PARTY.md.
"use client";

import { useAuthPlugin } from "@better-auth-ui/react";
import { Send } from "lucide-react";
import { organizationPlugin } from "@/features/account/organization-plugin";
import { Button } from "@/features/account/primitives/button";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/features/account/primitives/empty";

export type OrganizationInvitationsEmptyProps = {
	isInvitePending?: boolean;
	onInvitePress?: () => void;
};

/**
 * Empty state for `OrganizationInvitations`.
 */
export function OrganizationInvitationsEmpty({
	isInvitePending,
	onInvitePress,
}: OrganizationInvitationsEmptyProps) {
	const { localization: organizationLocalization } =
		useAuthPlugin(organizationPlugin);

	return (
		<Empty>
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<Send />
				</EmptyMedia>
				<EmptyTitle>{organizationLocalization.noInvitations}</EmptyTitle>
				<EmptyDescription>
					{organizationLocalization.organizationInvitationsEmptyDescription}
				</EmptyDescription>
			</EmptyHeader>
			{(isInvitePending || onInvitePress) && (
				<EmptyContent>
					<Button disabled={isInvitePending} size="sm" onClick={onInvitePress}>
						{organizationLocalization.inviteMember}
					</Button>
				</EmptyContent>
			)}
		</Empty>
	);
}
