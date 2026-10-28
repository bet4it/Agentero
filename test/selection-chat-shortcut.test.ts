import { expect, it, vi } from "vitest";
import {
	registerSelectionAddToChat,
	runSelectionAddToChat,
} from "@/lib/agent/selection-quick-chat";

it("offers the parent-window shortcut to the newest armed iframe selection", () => {
	const old = vi.fn(() => true);
	const latest = vi.fn(() => false);
	const releaseOld = registerSelectionAddToChat(old);
	const releaseLatest = registerSelectionAddToChat(latest);
	try {
		expect(runSelectionAddToChat()).toBe(true);
		expect(latest).toHaveBeenCalledOnce();
		expect(old).toHaveBeenCalledOnce();
		latest.mockReturnValue(true);
		old.mockClear();
		expect(runSelectionAddToChat()).toBe(true);
		expect(old).not.toHaveBeenCalled();
	} finally {
		releaseLatest();
		releaseOld();
	}
	expect(runSelectionAddToChat()).toBe(false);
});
