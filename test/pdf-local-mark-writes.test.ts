import { expect, it, vi } from "vitest";
import {
	deleteMarkFile,
	subscribeLocalMarkWrites,
	writeMarkFile,
} from "@/lib/pdf/selection/marks-io";

const mocks = vi.hoisted(() => ({
	write: vi.fn().mockResolvedValue(undefined),
	remove: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/core/tauri", () => ({ isTauri: () => true }));
vi.mock("@/lib/vault", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/vault")>()),
	writeVaultFile: mocks.write,
	removeVaultPath: mocks.remove,
}));

it("notifies sibling viewers after saved visual notes and deletions, without reporting failed writes as changes", async () => {
	const listener = vi.fn();
	const off = subscribeLocalMarkWrites(listener);
	try {
		await writeMarkFile("/vault/papers/a", "note", {
			id: "note",
			kind: "visual",
			comment: "saved",
		});
		await deleteMarkFile("/vault/papers/a", "note");
		expect(listener.mock.calls).toEqual([
			["/vault/papers/a/marks/note.json"],
			["/vault/papers/a/marks/note.json"],
		]);
		mocks.write.mockRejectedValueOnce(new Error("failed"));
		await expect(
			writeMarkFile("/vault/papers/a", "failed", {}),
		).rejects.toThrow("failed");
		expect(listener).toHaveBeenCalledTimes(2);
		off();
		await writeMarkFile("/vault/papers/a", "later", {});
		expect(listener).toHaveBeenCalledTimes(2);
	} finally {
		off();
	}
});
