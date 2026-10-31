import { useEffect, useState } from "react";
import {
	DEFAULT_UI_THEME,
	loadUiThemes,
	UI_THEMES,
	type UiThemeDef,
} from "@/lib/ui/theme";

/** Shared preview data for onboarding and appearance settings. */
export function useThemePreviews(isDark: boolean, defaultTitle: string) {
	const [themeDefs, setThemeDefs] = useState<UiThemeDef[]>([]);

	useEffect(() => {
		let active = true;
		void loadUiThemes()
			.then((themes) => {
				if (active) setThemeDefs(themes);
			})
			.catch(() => {
				// Manifest names remain usable if preview data fails to load.
			});
		return () => {
			active = false;
		};
	}, []);

	const defaultPreview = {
		background: isDark ? "oklch(0.145 0 0)" : "oklch(1 0 0)",
		card: isDark ? "oklch(0.205 0 0)" : "oklch(1 0 0)",
		primary: isDark ? "oklch(0.922 0 0)" : "oklch(0.205 0 0)",
		secondary: isDark ? "oklch(0.269 0 0)" : "oklch(0.97 0 0)",
		accent: isDark ? "oklch(0.269 0 0)" : "oklch(0.97 0 0)",
		foreground: isDark ? "oklch(0.985 0 0)" : "oklch(0.145 0 0)",
		border: isDark ? "oklch(1 0 0 / 10%)" : "oklch(0.922 0 0)",
	};
	const previewThemes = [
		{
			name: DEFAULT_UI_THEME,
			title: defaultTitle,
			light: defaultPreview,
			dark: defaultPreview,
		},
		...UI_THEMES.map(
			(meta) =>
				themeDefs.find((theme) => theme.name === meta.name) ?? {
					...meta,
					light: defaultPreview,
					dark: defaultPreview,
				},
		),
	];
	return { previewThemes, hasPreviewData: themeDefs.length > 0 };
}
