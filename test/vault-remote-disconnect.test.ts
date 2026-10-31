// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { activateVault } from "@/lib/vault/actions";
import {
	getRemoteSessionMeta,
	remoteDisconnect,
	saveRemoteSessionMeta,
} from "@/lib/vault/remote/remote-vault";
import { vaultStore } from "@/lib/vault/store";
import { workspaceStore } from "@/lib/workspace/store";

vi.mock("@/lib/core/tauri", () => ({
	isTauri: () => false,
	isMacOS: () => false,
	isMobileApp: () => false,
	getPlatformOS: () => "other",
}));
vi.mock("@/lib/vault/remote/remote-vault", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/vault/remote/remote-vault")>()),
	remoteDisconnect: vi.fn(),
}));

it("keeps the current remote vault and documents when publishing fails", async () => {
	const tree = [{ name: "paper", path: "papers/x", isDir: true, children: [] }];
	const tabs = [{ id: "doc", path: "papers/x/NOTES.md" }];
	vaultStore.setState({
		vaultPath: "remote:old",
		tree: tree as never,
		treeLoading: false,
	});
	workspaceStore.setState({ tabs: tabs as never, activeTabId: "doc" });
	saveRemoteSessionMeta({
		sessionId: "old",
		vaultHandle: "remote:old",
	} as never);
	vi.mocked(remoteDisconnect).mockRejectedValueOnce(
		new Error("publish failed"),
	);
	await expect(activateVault("/new")).rejects.toThrow("publish failed");
	expect(vaultStore.getState().vaultPath).toBe("remote:old");
	expect(vaultStore.getState().tree).toBe(tree);
	expect(vaultStore.getState().treeLoading).toBe(false);
	expect(workspaceStore.getState().tabs).toBe(tabs);
	expect(getRemoteSessionMeta()?.sessionId).toBe("old");
});
