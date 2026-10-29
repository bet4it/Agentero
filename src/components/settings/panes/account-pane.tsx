import { authQueryKeys } from "@better-auth-ui/core";
import { useHasPermission } from "@better-auth-ui/react/plugins/organization";
import { QueryClientProvider } from "@tanstack/react-query";
import { emit, listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { LogIn, LogOut, RefreshCw } from "lucide-react";
import { type ComponentProps, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	cancelAuth,
	onAuthError,
	onAuthenticated,
	onSignedOut,
	requestAuth,
	signOut,
} from "tauri-plugin-better-auth/client";
import { Button } from "@/components/ui/button";
import { accountWebOrigin, authClient } from "@/features/account/client";
import {
	accountQueryClient,
	clearAccountCache,
	useAccountSession,
	useOrganizations,
} from "@/features/account/data";
import { apiErrorMessage } from "@/features/account/errors";
import { zhAuthLocalization } from "@/features/account/localization";
import {
	enOrganizationLocalization,
	zhOrganizationLocalization,
} from "@/features/account/organization-localization";
import { organizationPlugin } from "@/features/account/organization-plugin";
import { AuthProvider } from "@/features/account/ui/auth-provider";
import { OrganizationDangerZone } from "@/features/account/ui/organization/organization-danger-zone";
import { OrganizationInvitations } from "@/features/account/ui/organization/organization-invitations";
import { OrganizationMembers } from "@/features/account/ui/organization/organization-members";
import { OrganizationProfile } from "@/features/account/ui/organization/organization-profile";
import { OrganizationSwitcher } from "@/features/account/ui/organization/organization-switcher";
import { Organizations } from "@/features/account/ui/organization/organizations";
import { UserInvitations } from "@/features/account/ui/organization/user-invitations";
import { UserProfile } from "@/features/account/ui/settings/account/user-profile";
import { notifyError } from "@/lib/core/notify";
import { isTauri } from "@/lib/core/tauri";
import { PageTitle } from "../settings-layout";

const ORGANIZATIONS_CHANGED = "account:organizations-changed";

function TeamContent() {
	const invite = useHasPermission(authClient, {
		permissions: { invitation: ["create"] },
	});
	return (
		<div className="space-y-6">
			<OrganizationProfile />
			<OrganizationMembers />
			{invite.data?.success && <OrganizationInvitations />}
			<OrganizationDangerZone />
		</div>
	);
}

function AccountContent() {
	const { t, i18n } = useTranslation("account");
	const session = useAccountSession();
	const organizations = useOrganizations();
	const [view, setView] = useState<"account" | "teams" | "team">("account");
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const selected = organizations.data?.find((org) => org.id === selectedId);
	const refresh = () => accountQueryClient.invalidateQueries();
	useEffect(() => {
		if (!isTauri()) return;
		let disposed = false;
		const cleanup: Array<() => void> = [];
		const register = (promise: Promise<() => void>) =>
			void promise.then((stop) => (disposed ? stop() : cleanup.push(stop)));
		register(
			onAuthenticated(() => {
				clearAccountCache();
				setPending(false);
				setSelectedId(null);
				setView("account");
				void accountQueryClient.invalidateQueries({
					queryKey: authQueryKeys.session,
				});
			}),
		);
		register(
			onSignedOut(() => {
				clearAccountCache();
				setPending(false);
				setSelectedId(null);
				setView("account");
			}),
		);
		register(
			onAuthError((error) => {
				setPending(false);
				if (!error.code.includes("CANCEL"))
					notifyError(apiErrorMessage(t, error));
			}),
		);
		register(
			listen<{ departing?: string }>(ORGANIZATIONS_CHANGED, (event) => {
				if (event.payload.departing) {
					const id = event.payload.departing;
					setSelectedId((current) => (current === id ? null : current));
					void accountQueryClient
						.cancelQueries({
							predicate: (q) => q.queryKey[3] === "organization",
						})
						.then(() => {
							accountQueryClient.setQueriesData<Array<{ id: string }>>(
								{
									predicate: (q) =>
										q.queryKey[3] === "organization" &&
										q.queryKey[4] === "list",
								},
								(old) => old?.filter((org) => org.id !== id),
							);
							void accountQueryClient.invalidateQueries({
								predicate: (q) =>
									q.queryKey[3] === "organization" && q.queryKey[4] === "list",
							});
						});
					return;
				}
				void accountQueryClient.invalidateQueries({
					predicate: (q) => q.queryKey[3] === "organization",
				});
			}),
		);
		cleanup.push(
			accountQueryClient.getMutationCache().subscribe((event) => {
				if (
					event.type !== "updated" ||
					event.action.type !== "success" ||
					event.mutation.options.mutationKey?.[1] !== "organization"
				)
					return;
				const departing = ["leave", "delete"].includes(
					String(event.mutation.options.mutationKey[2]),
				);
				void accountQueryClient.invalidateQueries({
					predicate: (q) => q.queryKey[3] === "organization",
					refetchType: departing ? "none" : "active",
				});
				// Other windows refresh their own membership view; this does not change
				// their selected team or any other device's active organization.
				void emit(ORGANIZATIONS_CHANGED, {
					departing: departing
						? (event.mutation.state.variables as { organizationId?: string })
								?.organizationId
						: undefined,
				});
			}),
		);
		return () => {
			disposed = true;
			cleanup.forEach((stop) => {
				stop();
			});
		};
	}, [t]);
	const start = async () => {
		setPending(true);
		try {
			const result = await requestAuth();
			if (!result.opened) await openUrl(result.url);
		} catch (error) {
			setPending(false);
			notifyError(apiErrorMessage(t, error));
		}
	};
	const navigate = async ({ to }: { to: string }) => {
		const slug = /^\/organizations\/([^/]+)/.exec(to)?.[1];
		if (slug) {
			const org = organizations.data?.find((item) => item.slug === slug);
			setSelectedId(org?.id ?? null);
			setView(org ? "team" : "teams");
		} else {
			setSelectedId(null);
			setView(to === "/account" ? "account" : "teams");
		}
	};
	const Link = ({
		href,
		children,
		...props
	}: ComponentProps<"a"> & { href: string }) => (
		<button
			type="button"
			className={props.className}
			tabIndex={props.tabIndex}
			aria-disabled={props["aria-disabled"]}
			onClick={(event) => {
				event.preventDefault();
				void navigate({ to: href });
			}}
		>
			{children}
		</button>
	);
	return (
		<>
			<PageTitle
				title={t("title")}
				actions={
					<Button
						size="icon"
						variant="ghost"
						aria-label={t("refresh")}
						onClick={() => void refresh()}
					>
						<RefreshCw className="size-4" />
					</Button>
				}
			/>
			{!session.data ? (
				<div className="space-y-4">
					<p className="text-sm text-muted-foreground">{t("localFirst")}</p>
					<Button
						disabled={pending || session.isPending}
						onClick={() => void start()}
					>
						<LogIn className="size-4" />
						{t(pending ? "waiting" : "signIn")}
					</Button>
					{pending && (
						<Button
							variant="outline"
							onClick={() =>
								void cancelAuth()
									.then(() => setPending(false))
									.catch((error) => notifyError(apiErrorMessage(t, error)))
							}
						>
							{t("common.cancel")}
						</Button>
					)}
				</div>
			) : (
				<AuthProvider
					authClient={authClient}
					queryClient={accountQueryClient}
					Link={Link}
					navigate={navigate}
					basePaths={{ settings: "", organization: "/organizations", auth: "" }}
					viewPaths={{ settings: { account: "account", security: "account" } }}
					emailAndPassword={{ enabled: false }}
					localization={
						i18n.language.startsWith("zh") ? zhAuthLocalization : undefined
					}
					plugins={[
						organizationPlugin({
							slug: selected?.slug ?? null,
							allowMultipleRoles: false,
							teams: false,
							localization: i18n.language.startsWith("zh")
								? zhOrganizationLocalization
								: enOrganizationLocalization,
							viewPaths: { settings: { organizations: "teams" } },
						}),
					]}
				>
					<div className="mb-6 flex flex-wrap items-center gap-2">
						<Button
							variant={view === "account" ? "secondary" : "ghost"}
							onClick={() => {
								setSelectedId(null);
								setView("account");
							}}
						>
							{t("profile")}
						</Button>
						<Button
							variant={view === "teams" ? "secondary" : "ghost"}
							onClick={() => {
								setSelectedId(null);
								setView("teams");
							}}
						>
							{t("teams")}
						</Button>
						<OrganizationSwitcher
							setActive={(org) => {
								setSelectedId(org?.id ?? null);
								setView(org ? "team" : "account");
							}}
						/>
					</div>
					{view === "team" && selected ? (
						<TeamContent />
					) : view === "teams" ? (
						<div className="space-y-6">
							<Organizations />
							<UserInvitations />
						</div>
					) : (
						<div className="space-y-5">
							<p className="text-sm">{session.data.user.email}</p>
							<UserProfile />
							<div className="flex gap-2">
								<Button
									variant="outline"
									onClick={() =>
										void signOut().catch((error) =>
											notifyError(apiErrorMessage(t, error)),
										)
									}
								>
									<LogOut className="size-4" />
									{t("signOut")}
								</Button>
								{"role" in session.data.user &&
									session.data.user.role === "admin" && (
										<Button
											variant="outline"
											onClick={() =>
												void openUrl(`${accountWebOrigin}/admin/users`).catch(
													(error) => notifyError(apiErrorMessage(t, error)),
												)
											}
										>
											{t("administration")}
										</Button>
									)}
							</div>
						</div>
					)}
				</AuthProvider>
			)}
		</>
	);
}

export function AccountPane() {
	return (
		<QueryClientProvider client={accountQueryClient}>
			<AccountContent />
		</QueryClientProvider>
	);
}
