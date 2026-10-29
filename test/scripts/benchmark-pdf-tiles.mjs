/**
 * Read-only PDFium raster comparison; not a UI frame-rate benchmark.
 * node test/scripts/benchmark-pdf-tiles.mjs /absolute/path/to/document.pdf [...]
 * Fixed: page 3, scale 1.5, DPR 2, top 800 CSS px, full page width.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createPdfiumEngine } from "@embedpdf/engines/pdfium-direct-engine";

const paths = process.argv.slice(2);
if (!paths.length) {
	throw new Error(
		"Pass one or more PDF paths; source files are never modified.",
	);
}
const wasm = await readFile(
	createRequire(import.meta.url).resolve("@embedpdf/pdfium/pdfium.wasm"),
);
const engine = await createPdfiumEngine(
	`data:application/wasm;base64,${wasm.toString("base64")}`,
	{ fontFallback: null },
);
const scale = 1.5;
const dpr = 2;
try {
	for (const path of paths) {
		const bytes = await readFile(path);
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		const doc = await engine
			.openDocumentBuffer({
				id: sha256,
				content: bytes.buffer.slice(
					bytes.byteOffset,
					bytes.byteOffset + bytes.byteLength,
				),
			})
			.toPromise();
		try {
			const page = doc.pages[2];
			if (!page) throw new Error(`${path}: fewer than three pages`);
			// Same visible area for every condition. Keep upstream 2.5px overlaps
			// and complete boundary tiles, as the actual tiling plugin does.
			for (const tileSize of [768, 512, 384, 512, 768]) {
				const trials = [];
				for (let trial = 0; trial < 3; trial++) {
					const times = [];
					const step = tileSize - 2.5;
					const width = page.size.width * scale;
					const height = page.size.height * scale;
					for (let x = 0; x < width; x += step) {
						for (let y = 0; y < Math.min(800, height); y += step) {
							const start = performance.now();
							await engine
								.renderPageRectRaw(
									doc,
									page,
									{
										origin: { x: x / scale, y: y / scale },
										size: {
											width: Math.min(tileSize, width - x) / scale,
											height: Math.min(tileSize, height - y) / scale,
										},
									},
									{ scaleFactor: scale, dpr, rotation: 0 },
								)
								.toPromise();
							times.push(performance.now() - start);
						}
					}
					trials.push({
						totalMs: Math.round(times.reduce((a, b) => a + b, 0)),
						maxMs: Math.round(Math.max(...times)),
						tiles: times.length,
					});
				}
				console.log(
					JSON.stringify({
						path,
						sha256,
						page: 3,
						scale,
						dpr,
						pageSize: page.size,
						viewportHeight: 800,
						tileSize,
						trials,
					}),
				);
			}
		} finally {
			await engine.closeDocument(doc).toPromise();
		}
	}
} finally {
	await engine.destroy().toPromise();
}
