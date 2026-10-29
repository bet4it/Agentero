import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingsRow } from "@/components/settings/settings-layout";
import { Switch } from "@/components/ui/switch";
import { useTauriEvent } from "@/hooks/use-tauri-event";
import { commands, events, type WordStatus } from "@/lib/core/bindings";
import { callResult } from "@/lib/core/ipc";
import { notifyError } from "@/lib/core/notify";
import { isMacOS, isTauri, isWindows } from "@/lib/core/tauri";
import { wordError } from "@/lib/word/errors";

export function WordSettings() {
	const { t } = useTranslation("settings");
	const [status, setStatus] = useState<WordStatus | null>(null);
	const [busy, setBusy] = useState(false);
	const supported = isMacOS() || isWindows();
	const refresh = useCallback(async () => {
		if (!isTauri() || !(isMacOS() || isWindows())) return;
		try {
			setStatus(await commands.wordGetStatus());
		} catch (error) {
			notifyError(wordError(error));
		}
	}, []);
	useEffect(() => {
		void refresh();
	}, [refresh]);
	useTauriEvent(events.wordChanged, () => {
		void refresh();
	});
	if (!supported) return null;
	return (
		<SettingsRow label={t("word.label")} htmlFor="word-enabled">
			<Switch
				id="word-enabled"
				checked={status?.enabled ?? false}
				disabled={busy || status?.busy}
				onCheckedChange={async (enabled) => {
					setBusy(true);
					try {
						setStatus(await callResult(() => commands.wordSetEnabled(enabled)));
					} catch (error) {
						notifyError(wordError(error));
					} finally {
						setBusy(false);
					}
				}}
			/>
		</SettingsRow>
	);
}
