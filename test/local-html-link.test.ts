import { describe, expect, it } from "vitest";
import { isLocalHtmlLink } from "@/lib/workspace/viewer-actions";

describe("isLocalHtmlLink", () => {
	it("accepts vault-relative and absolute local HTML paths", () => {
		expect(isLocalHtmlLink("papers/a/demo.html")).toBe(true);
		expect(isLocalHtmlLink("/Users/me/vault/papers/a/demo.html")).toBe(true);
		expect(isLocalHtmlLink("C:\\vault\\papers\\a\\demo.html")).toBe(true);
		expect(isLocalHtmlLink("papers/a/report.htm#page=2")).toBe(true);
	});

	it("rejects URLs, anchors, protocol-relative and non-HTML paths", () => {
		expect(isLocalHtmlLink("https://example.com/demo.html")).toBe(false);
		expect(isLocalHtmlLink("file:///Users/me/demo.html")).toBe(false);
		expect(isLocalHtmlLink("//example.com/demo.html")).toBe(false);
		expect(isLocalHtmlLink("#demo")).toBe(false);
		expect(isLocalHtmlLink("papers/a/notes.md")).toBe(false);
	});
});
