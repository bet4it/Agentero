import {
	authQueryKeys,
	sessionOptions as upstreamSessionOptions,
} from "@better-auth-ui/core";
import {
	type DeleteOrganizationOptions,
	deleteOrganizationOptions,
	type LeaveOrganizationOptions,
	leaveOrganizationOptions,
	listOrganizationsOptions,
	type OrganizationAuthClient,
	organizationQueryKeys,
} from "@better-auth-ui/core/plugins/organization";
import { QueryClient, useMutation, useQuery } from "@tanstack/react-query";
import { tauriFetch } from "tauri-plugin-better-auth/client";
import { accountApiOrigin, authClient } from "./client";

export const accountQueryClient = new QueryClient({
	defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
});
export const accountSessionOptions = upstreamSessionOptions(authClient);
export const useAccountSession = () => useQuery(accountSessionOptions);
export function useOrganizations() {
	const { data } = useAccountSession();
	return useQuery(listOrganizationsOptions(authClient, data?.user.id));
}
export function clearAccountCache() {
	void accountQueryClient.cancelQueries();
	accountQueryClient.removeQueries({
		predicate: (q) =>
			JSON.stringify(q.queryKey) !== JSON.stringify(authQueryKeys.session),
	});
	accountQueryClient.setQueryData(authQueryKeys.session, null);
}
async function removeDepartedOrganization(
	userId: string | undefined,
	organizationId: string,
) {
	const queryKey = organizationQueryKeys.lists(userId);
	await accountQueryClient.cancelQueries({ queryKey });
	accountQueryClient.setQueriesData<Array<{ id: string }>>(
		{ queryKey },
		(old) => old?.filter((org) => org.id !== organizationId),
	);
}
export function useLeaveOrganization(
	client: OrganizationAuthClient,
	options: LeaveOrganizationOptions,
) {
	const { data: session } = useAccountSession();
	return useMutation({
		...leaveOrganizationOptions(client, session?.user.id),
		...options,
		meta: {},
		onSuccess: async (data, variables, result, context) => {
			await removeDepartedOrganization(
				session?.user.id,
				variables.organizationId,
			);
			await options.onSuccess?.(data, variables, result, context);
		},
	});
}
export function useDeleteOrganization(
	client: OrganizationAuthClient,
	options: DeleteOrganizationOptions,
) {
	const { data: session } = useAccountSession();
	return useMutation({
		...deleteOrganizationOptions(client, session?.user.id),
		...options,
		meta: {},
		onSuccess: async (data, variables, result, context) => {
			await removeDepartedOrganization(
				session?.user.id,
				variables.organizationId,
			);
			await options.onSuccess?.(data, variables, result, context);
		},
	});
}
export function useTransferOwnership(organizationId: string) {
	return useMutation({
		mutationKey: ["auth", "organization", "transferOwnership"],
		meta: { errorPresentation: "inline" },
		mutationFn: async (targetUserId: string) => {
			const response = await tauriFetch(
				`${accountApiOrigin}/api/desktop/transfer-ownership`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ organizationId, targetUserId }),
				},
			);
			const body = await response.json();
			if (!response.ok)
				throw Object.assign(new Error("TRANSFER_FAILED"), {
					code: body.code ?? body.error?.code,
				});
			return body;
		},
		onSuccess: () =>
			accountQueryClient.invalidateQueries({
				predicate: (q) => q.queryKey[3] === "organization",
			}),
	});
}
