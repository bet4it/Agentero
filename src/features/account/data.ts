import {
	authQueryKeys,
	sessionOptions as upstreamSessionOptions,
} from "@better-auth-ui/core";
import { listOrganizationsOptions } from "@better-auth-ui/core/plugins/organization";
import { QueryClient, useQuery } from "@tanstack/react-query";
import { authClient } from "./client";

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
