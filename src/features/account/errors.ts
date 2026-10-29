import type { TFunction } from "i18next";

export function apiErrorMessage(
	t: TFunction<"account">,
	error: unknown,
): string {
	const code =
		typeof error === "object" && error && "code" in error
			? String(error.code)
			: "";
	if (code.includes("PLAN_LIMIT") || code.includes("LIMIT_REACHED"))
		return t("errors.limit");
	if (code.includes("ORG_FROZEN")) return t("errors.frozen");
	if (code.includes("OWNER")) return t("errors.owner");
	if (
		code.includes("STORAGE") ||
		code.includes("STORE") ||
		code.includes("KEYCHAIN")
	)
		return t("errors.storage");
	if (
		code.includes("UNAUTHORIZED") ||
		code.includes("FORBIDDEN") ||
		code.includes("NOT_ALLOWED")
	)
		return t("errors.permission");
	return t("errors.generic");
}
