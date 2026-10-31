import { createStore } from "zustand/vanilla";
import { createPathRemapper, dirnameOf, normalizePath } from "@/lib/core/path";
import { readJsonStorage, writeJsonStorage } from "@/lib/core/storage";
import type { LatexBuildOptions, LatexRecipe } from "@/lib/tex/host";

export type TexAutoBuild = "never" | "onSave" | "onFileChange";
export type TexProjectSettings = {
	autoBuild: TexAutoBuild;
	syncAfterBuild: boolean;
	recipe: NonNullable<LatexBuildOptions["recipe"]> | null;
	recipes: LatexRecipe[];
	selectedRecipe: string | null;
	outDir: string;
	auxDir: string;
	jobname: string;
};

export const DEFAULT_TEX_SETTINGS: TexProjectSettings = {
	autoBuild: "onSave",
	syncAfterBuild: false,
	recipe: null,
	recipes: [],
	selectedRecipe: null,
	outDir: "",
	auxDir: "",
	jobname: "",
};

const STORAGE_KEY = "agentero.texProjects.v1";
type TexSettingsState = {
	projects: Record<string, TexProjectSettings>;
	/** Directory -> explicitly chosen root, including a subfiles document. */
	roots: Record<string, string>;
};

export function validateTexSettings(value: unknown): TexProjectSettings {
	if (!value || typeof value !== "object") throw new Error("invalidSettings");
	const input = value as Record<string, unknown>;
	const autoBuild = input.autoBuild ?? "never";
	if (!["never", "onSave", "onFileChange"].includes(String(autoBuild))) {
		throw new Error("invalidSettings");
	}
	const recipes = input.recipes ?? (input.recipe ? [input.recipe] : []);
	if (!Array.isArray(recipes)) throw new Error("invalidRecipe");
	for (const recipe of recipes) {
		if (!recipe || typeof recipe !== "object") throw new Error("invalidRecipe");
		const candidate = recipe as { name?: unknown; tools?: unknown };
		if (
			typeof candidate.name !== "string" ||
			!candidate.name.trim() ||
			!Array.isArray(candidate.tools) ||
			candidate.tools.length === 0
		) {
			throw new Error("invalidRecipe");
		}
		for (const tool of candidate.tools) {
			if (
				!tool ||
				typeof tool.command !== "string" ||
				!tool.command.trim() ||
				!Array.isArray(tool.args) ||
				tool.args.some((arg: unknown) => typeof arg !== "string") ||
				(tool.cwd != null && typeof tool.cwd !== "string") ||
				(tool.env != null &&
					(typeof tool.env !== "object" ||
						Array.isArray(tool.env) ||
						Object.values(tool.env).some((entry) => typeof entry !== "string")))
			) {
				throw new Error("invalidRecipe");
			}
		}
	}
	const names = recipes.map((recipe) => recipe.name);
	if (new Set(names).size !== names.length) throw new Error("invalidRecipe");
	const selectedRecipe =
		"selectedRecipe" in input
			? input.selectedRecipe
			: ((input.recipe as LatexRecipe | undefined)?.name ?? null);
	if (selectedRecipe !== null && !names.includes(selectedRecipe))
		throw new Error("invalidRecipe");
	for (const name of ["outDir", "auxDir", "jobname"]) {
		if (input[name] != null && typeof input[name] !== "string")
			throw new Error("invalidSettings");
	}
	if (
		input.syncAfterBuild != null &&
		typeof input.syncAfterBuild !== "boolean"
	) {
		throw new Error("invalidSettings");
	}
	return {
		autoBuild: autoBuild as TexAutoBuild,
		syncAfterBuild: input.syncAfterBuild === true,
		recipes: recipes as LatexRecipe[],
		selectedRecipe: selectedRecipe as string | null,
		recipe: recipes.find((recipe) => recipe.name === selectedRecipe) ?? null,
		outDir: (input.outDir as string | undefined)?.trim() ?? "",
		auxDir: (input.auxDir as string | undefined)?.trim() ?? "",
		jobname: (input.jobname as string | undefined)?.trim() ?? "",
	};
}

function loadSettings(): TexSettingsState {
	const saved = readJsonStorage<Partial<TexSettingsState>>(STORAGE_KEY, {});
	const projects: TexSettingsState["projects"] = {};
	for (const [path, value] of Object.entries(saved?.projects ?? {})) {
		try {
			projects[path] = { ...validateTexSettings(value), autoBuild: "onSave" };
		} catch {
			/* Ignore invalid persisted entries. */
		}
	}
	const roots = Object.fromEntries(
		Object.entries(saved?.roots ?? {}).filter(
			([, root]) => typeof root === "string" && /\.tex$/i.test(root),
		),
	);
	return { projects, roots };
}

export const texSettingsStore = createStore<TexSettingsState>(loadSettings);

export function getTexProjectSettings(rootPath: string): TexProjectSettings {
	return (
		texSettingsStore.getState().projects[normalizePath(rootPath)] ??
		DEFAULT_TEX_SETTINGS
	);
}

export function setTexProjectSettings(
	rootPath: string,
	settings: TexProjectSettings,
): void {
	const next = validateTexSettings(settings);
	texSettingsStore.setState((state) => ({
		projects: { ...state.projects, [normalizePath(rootPath)]: next },
	}));
	writeJsonStorage(STORAGE_KEY, texSettingsStore.getState());
}

export function setTexProjectRoot(sourcePath: string, rootPath: string): void {
	const dir = dirnameOf(rootPath || sourcePath);
	texSettingsStore.setState((state) => {
		const roots = { ...state.roots };
		const path = normalizePath(sourcePath);
		const chosenDir = normalizePath(dir);
		for (const key of Object.keys(roots)) {
			const containsSource = path === key || path.startsWith(`${key}/`);
			if (
				containsSource &&
				(!rootPath ||
					key === path ||
					key === chosenDir ||
					key.startsWith(`${chosenDir}/`))
			)
				delete roots[key];
		}
		if (rootPath)
			roots[normalizePath(rootPath) === path ? path : chosenDir] = rootPath;
		return { roots };
	});
	writeJsonStorage(STORAGE_KEY, texSettingsStore.getState());
}

/** Make one file the compile root for every source under `directory`. */
export function setDirectoryTexRoot(directory: string, rootPath: string): void {
	const dir = normalizePath(directory);
	texSettingsStore.setState((state) => {
		const roots = { ...state.roots };
		for (const key of Object.keys(roots)) {
			if (key === dir || key.startsWith(`${dir}/`)) delete roots[key];
		}
		roots[dir] = rootPath;
		return { roots };
	});
	writeJsonStorage(STORAGE_KEY, texSettingsStore.getState());
}

/** Keep compile-root choices attached after a file or folder moves. */
export function remapTexSettingsPaths(
	moves: readonly { from: string; to: string }[],
): void {
	if (moves.length === 0) return;
	const remap = createPathRemapper(moves);
	texSettingsStore.setState((state) => {
		const projects: TexSettingsState["projects"] = {};
		for (const [key, value] of Object.entries(state.projects)) {
			projects[remap(key)] = value;
		}
		const roots: TexSettingsState["roots"] = {};
		for (const [key, value] of Object.entries(state.roots)) {
			roots[remap(key)] = remap(value);
		}
		return { projects, roots };
	});
	writeJsonStorage(STORAGE_KEY, texSettingsStore.getState());
}

export function explicitTexRoot(sourcePath: string): string | undefined {
	const path = normalizePath(sourcePath);
	return Object.entries(texSettingsStore.getState().roots)
		.filter(([dir]) => path === dir || path.startsWith(`${dir}/`))
		.sort(([a], [b]) => b.length - a.length)[0]?.[1];
}

export function texBuildOptions(
	rootPath: string,
	mode: "normal" | "force" | "clean" = "normal",
): LatexBuildOptions {
	const settings = getTexProjectSettings(rootPath);
	return {
		...(settings.recipe ? { recipe: settings.recipe } : {}),
		...(settings.outDir ? { outDir: settings.outDir } : {}),
		...(settings.auxDir ? { auxDir: settings.auxDir } : {}),
		...(settings.jobname ? { jobname: settings.jobname } : {}),
		force: mode !== "normal",
		clean: mode === "clean",
	};
}
