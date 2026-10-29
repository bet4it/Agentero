import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatBytes } from "@/lib/core/background-tasks";
import { type SyncCloudUsage, syncCloudUsage } from "@/lib/sync/api";

export function useCloudUsage(
	subject: "user" | "organization",
	orgId?: string,
) {
	const [usage, setUsage] = useState<SyncCloudUsage | null>(null);
	useEffect(() => {
		let cancelled = false;
		void syncCloudUsage(subject, orgId)
			.then((next) => {
				if (!cancelled) setUsage(next);
			})
			.catch(() => {
				if (!cancelled) setUsage(null);
			});
		return () => {
			cancelled = true;
		};
	}, [subject, orgId]);
	return usage;
}

export function CloudUsageLine({
	subject,
	orgId,
	namespace = "settings",
}: {
	subject: "user" | "organization";
	orgId?: string;
	namespace?: "settings" | "account";
}) {
	const { t } = useTranslation(namespace);
	const usage = useCloudUsage(subject, orgId);
	if (!usage) return null;
	if (!usage.signedIn) {
		return (
			<p className="text-muted-foreground text-xs">
				{t("cloudSync.signInRequired")}
			</p>
		);
	}
	const limit =
		usage.limit < 0 ? t("cloudSync.unlimited") : formatBytes(usage.limit);
	return (
		<div className="space-y-1">
			<p className="text-sm">
				{t("cloudSync.usedOf", { used: formatBytes(usage.used), limit })}
			</p>
			{usage.limit === 0 ? (
				<p className="text-muted-foreground text-xs">
					{t("cloudSync.notIncluded")}
				</p>
			) : null}
		</div>
	);
}
