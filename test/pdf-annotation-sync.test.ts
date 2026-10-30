import {
	PluginRegistry,
	setDocumentLoaded,
	startLoadingDocument,
} from "@embedpdf/core";
import {
	PdfAnnotationSubtype,
	type PdfDocumentObject,
	type PdfEngine,
	type PdfHighlightAnnoObject,
	PdfTaskHelper,
} from "@embedpdf/models";
import {
	AnnotationPlugin,
	AnnotationPluginPackage,
	type AnnotationScope,
} from "@embedpdf/plugin-annotation";
import { InteractionManagerPluginPackage } from "@embedpdf/plugin-interaction-manager";
import { SelectionPluginPackage } from "@embedpdf/plugin-selection";
import { expect, it } from "vitest";
import {
	isLiveAnnotation,
	loadAnnotationItems,
	saveAnnotationItems,
} from "@/lib/pdf/highlight/annotation-store";
import {
	applyAnnotationMutation,
	enqueueAnnotationSave,
	publishAnnotationMutation,
	subscribeAnnotationPeer,
} from "@/lib/pdf/highlight/annotation-sync";

async function viewer(id: string) {
	const registry = new PluginRegistry({
		getAllAnnotations: () => PdfTaskHelper.resolve({}),
	} as unknown as PdfEngine);
	registry.registerPlugin(InteractionManagerPluginPackage);
	registry.registerPlugin(SelectionPluginPackage);
	registry.registerPlugin(AnnotationPluginPackage, { autoCommit: false });
	await registry.initialize();
	registry.getStore().dispatchToCore(startLoadingDocument(id));
	registry.getStore().dispatchToCore(
		setDocumentLoaded(id, {
			id,
			pageCount: 1,
			pages: [{ index: 0, size: { width: 600, height: 800 } }],
		} as PdfDocumentObject),
	);
	const scope = registry
		.getPlugin<AnnotationPlugin>(AnnotationPlugin.id)
		?.provides()
		.forDocument(id);
	if (!scope) throw new Error("Annotation scope missing");
	let receiving = false;
	const offPeer = subscribeAnnotationPeer("/vault/papers/sync", id, (event) => {
		receiving = true;
		try {
			applyAnnotationMutation(scope, event);
		} finally {
			receiving = false;
		}
	});
	const offEvent = scope.onAnnotationEvent((event) => {
		if (!receiving) publishAnnotationMutation("/vault/papers/sync", event);
	});
	return {
		scope,
		async dispose() {
			offPeer();
			offEvent();
			await registry.destroy();
		},
	};
}
const highlight = (id: string): PdfHighlightAnnoObject => ({
	id,
	pageIndex: 0,
	type: PdfAnnotationSubtype.HIGHLIGHT,
	rect: { origin: { x: 20, y: 30 }, size: { width: 60, height: 10 } },
	segmentRects: [],
	strokeColor: "#ffff00",
	custom: { quote: "quoted text" },
});
const live = (scope: AnnotationScope) =>
	scope
		.getAnnotations()
		.filter(isLiveAnnotation)
		.map((item) => item.object);

it("shares highlights, comments, recolouring and deletions between main/embedded viewers, including a late-mounted embed", async () => {
	const main = await viewer("main");
	const embed = await viewer("embed");
	let late: Awaited<ReturnType<typeof viewer>> | undefined;
	try {
		embed.scope.createAnnotation(0, highlight("h1"));
		embed.scope.updateAnnotation(0, "h1", { contents: "note from embed" });
		main.scope.updateAnnotation(0, "h1", { strokeColor: "#ff0000" });
		main.scope.createAnnotation(0, highlight("h2"));
		expect(live(main.scope)).toEqual(live(embed.scope));
		late = await viewer("late");
		expect(live(late.scope)).toEqual(live(main.scope));
		embed.scope.deleteAnnotation(0, "h1");
		expect(live(main.scope).map((item) => item.id)).toEqual(["h2"]);
		expect(live(late.scope)).toEqual(live(main.scope));
		await enqueueAnnotationSave("/vault/papers/sync", async () => {
			await saveAnnotationItems(
				"/vault/papers/sync",
				await embed.scope.exportAnnotations().toPromise(),
			);
		});
		expect(
			(await loadAnnotationItems("/vault/papers/sync")).map(
				(item) => item.annotation.id,
			),
		).toEqual(["h2"]);
	} finally {
		await main.dispose();
		await embed.dispose();
		await late?.dispose();
	}
});

it("serializes snapshot exports and continues after a failed write", async () => {
	const order: string[] = [];
	let release = () => {};
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	const first = enqueueAnnotationSave("/vault/queue", async () => {
		order.push("first");
		await blocked;
		throw new Error("failed");
	});
	const failed = expect(first).rejects.toThrow("failed");
	const second = enqueueAnnotationSave("/vault/queue", async () => {
		order.push("second");
	});
	await Promise.resolve();
	await Promise.resolve();
	expect(order).toEqual(["first"]);
	release();
	await failed;
	await second;
	expect(order).toEqual(["first", "second"]);
});
