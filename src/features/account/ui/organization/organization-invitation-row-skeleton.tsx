// Adapted from Better Auth UI 1.7.32 (MIT). See THIRD_PARTY.md.
"use client";

import { Skeleton } from "@/features/account/primitives/skeleton";
import { TableCell, TableRow } from "@/features/account/primitives/table";

/**
 * Placeholder row matching `OrganizationInvitationRow` while invitations load.
 */
export function OrganizationInvitationRowSkeleton() {
	return (
		<TableRow>
			<TableCell>
				<Skeleton className="h-4 w-48 rounded-md" />
			</TableCell>

			<TableCell>
				<Skeleton className="h-4 w-36 rounded-md" />
			</TableCell>

			<TableCell>
				<Skeleton className="h-4 w-16 rounded-md" />
			</TableCell>

			<TableCell>
				<Skeleton className="h-4 w-14 rounded-full" />
			</TableCell>

			<TableCell />
		</TableRow>
	);
}
