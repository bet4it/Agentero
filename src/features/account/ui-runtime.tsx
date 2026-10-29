import {
	getAuthErrorCode,
	getAuthErrorPresentation,
} from "@better-auth-ui/core";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { notifyError } from "@/lib/core/notify";
import { apiErrorMessage } from "./errors";

export function AuthErrorToaster() {
	const client = useQueryClient();
	const { t } = useTranslation("account");
	useEffect(() => {
		const stopMutation = client.getMutationCache().subscribe((event) => {
			if (
				event.type === "updated" &&
				event.action.type === "error" &&
				getAuthErrorPresentation(event.mutation.meta) === "toast"
			)
				notifyError(
					apiErrorMessage(t, {
						code: getAuthErrorCode(event.mutation.state.error),
					}),
				);
		});
		const stopQuery = client.getQueryCache().subscribe((event) => {
			if (
				event.type === "updated" &&
				event.action.type === "error" &&
				getAuthErrorPresentation(event.query.meta) === "toast"
			)
				notifyError(
					apiErrorMessage(t, {
						code: getAuthErrorCode(event.query.state.error),
					}),
				);
		});
		return () => {
			stopMutation();
			stopQuery();
		};
	}, [client, t]);
	return null;
}
