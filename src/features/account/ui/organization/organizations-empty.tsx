// Adapted from Better Auth UI 1.7.32 (MIT). See THIRD_PARTY.md.
"use client";

import { useAuthPlugin } from "@better-auth-ui/react";
import { Briefcase } from "lucide-react";
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

export type OrganizationsEmptyProps = {
	onCreatePress: () => void;
	canCreate?: boolean;
};

export function OrganizationsEmpty({
	onCreatePress,
	canCreate = true,
}: OrganizationsEmptyProps) {
	const { localization: organizationLocalization } =
		useAuthPlugin(organizationPlugin);

	return (
		<Empty>
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<Briefcase />
				</EmptyMedia>
				<EmptyTitle>{organizationLocalization.noOrganizations}</EmptyTitle>
				<EmptyDescription>
					{organizationLocalization.organizationsDescription}
				</EmptyDescription>
			</EmptyHeader>
			<EmptyContent>
				<Button size="sm" disabled={!canCreate} onClick={onCreatePress}>
					{organizationLocalization.createOrganization}
				</Button>
			</EmptyContent>
		</Empty>
	);
}
