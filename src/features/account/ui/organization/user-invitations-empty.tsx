// Adapted from Better Auth UI 1.7.32 (MIT). See THIRD_PARTY.md.
"use client";

import { useAuthPlugin } from "@better-auth-ui/react";
import { MailWarning, Send } from "lucide-react";
import { organizationPlugin } from "@/features/account/organization-plugin";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/features/account/primitives/empty";

/**
 * Empty state for `UserInvitations`.
 */
export function UserInvitationsEmpty({
	verificationRequired = false,
}: {
	verificationRequired?: boolean;
}) {
	const { localization: organizationLocalization } =
		useAuthPlugin(organizationPlugin);

	return (
		<Empty>
			<EmptyHeader>
				<EmptyMedia variant="icon">
					{verificationRequired ? <MailWarning /> : <Send />}
				</EmptyMedia>
				<EmptyTitle>
					{verificationRequired
						? organizationLocalization.verifyEmailToViewInvitations
						: organizationLocalization.noInvitations}
				</EmptyTitle>
				<EmptyDescription>
					{verificationRequired
						? organizationLocalization.verifyEmailToViewInvitationsDescription
						: organizationLocalization.userInvitationsEmptyDescription}
				</EmptyDescription>
			</EmptyHeader>
		</Empty>
	);
}
