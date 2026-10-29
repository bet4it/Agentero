// Adapted from Better Auth UI 1.7.32 (MIT). See THIRD_PARTY.md.
"use client";

import type { OrganizationAuthClient } from "@better-auth-ui/core/plugins/organization";
import { useAuth, useAuthPlugin } from "@better-auth-ui/react";
import { useSetActiveOrganization } from "@better-auth-ui/react/plugins/organization";
import type { Organization } from "better-auth/client";
import { Settings as SettingsIcon } from "lucide-react";
import { organizationPlugin } from "@/features/account/organization-plugin";
import { Button } from "@/features/account/primitives/button";
import { Item, ItemActions } from "@/features/account/primitives/item";
import { Spinner } from "@/features/account/primitives/spinner";
import { OrganizationView } from "./organization-view";

export type OrganizationRowProps = {
	organization: Organization;
};

/**
 * Single organization row: logo and labels via `OrganizationView`, plus a Manage action.
 */
export function OrganizationRow({ organization }: OrganizationRowProps) {
	const { authClient, basePaths, navigate } = useAuth<OrganizationAuthClient>();
	const {
		localization: organizationLocalization,
		viewPaths: organizationViewPaths,
		slug,
		slugPrefix,
	} = useAuthPlugin(organizationPlugin);

	const { mutate: setActiveOrganization, isPending: setActivePending } =
		useSetActiveOrganization(authClient, {
			onSuccess: () => {
				navigate({
					to: `${basePaths.organization}/${organizationViewPaths.organization.settings}`,
				});
			},
		});

	function manageOrganization() {
		if (slug !== undefined) {
			navigate({
				to: `${basePaths.organization}/${slugPrefix}${organization.slug}/${organizationViewPaths.organization.settings}`,
			});
		} else {
			setActiveOrganization({ organizationId: organization.id });
		}
	}

	return (
		<Item>
			<OrganizationView className="flex-1" organization={organization} />
			<ItemActions>
				<Button
					variant="outline"
					size="sm"
					disabled={setActivePending}
					onClick={manageOrganization}
					aria-label={organizationLocalization.manage}
				>
					{setActivePending ? <Spinner /> : <SettingsIcon />}

					{organizationLocalization.manage}
				</Button>
			</ItemActions>
		</Item>
	);
}
