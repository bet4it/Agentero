import { LoaderCircle, MessageSquare } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
	SettingsGroup,
	SettingsRow,
} from "@/components/settings/settings-layout";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { commands } from "@/lib/core/bindings";
import { type ApiError, callApi } from "@/lib/core/ipc";
import { notifyError, notifySuccess } from "@/lib/core/notify";

const MESSAGE_MAX = 4000;
const CONTACT_MAX = 200;

type Kind = "bug" | "idea";

function feedbackReason(err: unknown): string | undefined {
	const details = (err as ApiError).details;
	if (!details || typeof details !== "object" || !("reason" in details)) {
		return undefined;
	}
	const reason = (details as { reason?: unknown }).reason;
	return typeof reason === "string" ? reason : undefined;
}

export function AboutFeedback() {
	const { t, i18n } = useTranslation(["settings", "common"]);
	const [open, setOpen] = useState(false);
	const [kind, setKind] = useState<Kind>("bug");
	const [message, setMessage] = useState("");
	const [contact, setContact] = useState("");
	const [busy, setBusy] = useState(false);

	const onSubmit = () => {
		const body = message.trim();
		if (!body) {
			notifyError(t("about.feedback.invalid"));
			return;
		}
		setBusy(true);
		void callApi(
			() =>
				commands.feedbackSubmit({
					category: kind,
					message: body,
					contact: contact.trim() || null,
					locale: i18n.language,
				}),
			{ fallback: t("about.feedback.failed") },
		)
			.then(() => {
				notifySuccess(t("about.feedback.sent"));
				setMessage("");
				setContact("");
				setKind("bug");
				setOpen(false);
			})
			.catch((err: unknown) => {
				const reason = feedbackReason(err);
				notifyError(
					reason === "unavailable"
						? t("about.feedback.unavailable")
						: reason === "invalid"
							? t("about.feedback.invalid")
							: t("about.feedback.failed"),
				);
			})
			.finally(() => setBusy(false));
	};

	return (
		<>
			<SettingsGroup>
				<SettingsRow
					label={
						<span className="inline-flex items-center gap-1.5">
							<MessageSquare
								className="size-3.5 shrink-0 text-muted-foreground"
								aria-hidden
							/>
							{t("about.feedback.label")}
						</span>
					}
					description={t("about.feedback.description")}
				>
					<Button variant="outline" size="sm" onClick={() => setOpen(true)}>
						{t("about.feedback.open")}
					</Button>
				</SettingsRow>
			</SettingsGroup>
			<Dialog
				open={open}
				onOpenChange={(next) => {
					if (!next && busy) return;
					setOpen(next);
				}}
			>
				<DialogContent showCloseButton={false} className="sm:max-w-md">
					<form
						onSubmit={(event) => {
							event.preventDefault();
							onSubmit();
						}}
					>
						<DialogHeader>
							<DialogTitle>{t("about.feedback.title")}</DialogTitle>
							<DialogDescription>{t("about.feedback.hint")}</DialogDescription>
						</DialogHeader>
						<div className="space-y-3 py-3">
							<div className="flex gap-2">
								<Button
									type="button"
									size="sm"
									variant={kind === "bug" ? "default" : "outline"}
									disabled={busy}
									onClick={() => setKind("bug")}
								>
									{t("about.feedback.kindBug")}
								</Button>
								<Button
									type="button"
									size="sm"
									variant={kind === "idea" ? "default" : "outline"}
									disabled={busy}
									onClick={() => setKind("idea")}
								>
									{t("about.feedback.kindIdea")}
								</Button>
							</div>
							<div className="space-y-1.5">
								<Label
									htmlFor="about-feedback-message"
									className="text-muted-foreground text-xs"
								>
									{t("about.feedback.message")}
								</Label>
								<Textarea
									id="about-feedback-message"
									value={message}
									maxLength={MESSAGE_MAX}
									disabled={busy}
									placeholder={t("about.feedback.messagePlaceholder")}
									className="min-h-24"
									onChange={(event) => setMessage(event.target.value)}
								/>
							</div>
							<div className="space-y-1.5">
								<Label
									htmlFor="about-feedback-contact"
									className="text-muted-foreground text-xs"
								>
									{t("about.feedback.contact")}
								</Label>
								<Input
									id="about-feedback-contact"
									type="email"
									value={contact}
									maxLength={CONTACT_MAX}
									disabled={busy}
									placeholder={t("about.feedback.contactPlaceholder")}
									autoComplete="email"
									onChange={(event) => setContact(event.target.value)}
								/>
							</div>
						</div>
						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								size="sm"
								disabled={busy}
								onClick={() => setOpen(false)}
							>
								{t("common:cancel")}
							</Button>
							<Button
								type="submit"
								size="sm"
								disabled={busy || !message.trim()}
							>
								{busy ? (
									<LoaderCircle
										data-icon="inline-start"
										className="animate-spin"
									/>
								) : null}
								{busy ? t("about.feedback.sending") : t("about.feedback.send")}
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</>
	);
}
