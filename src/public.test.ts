import { expect, test } from "bun:test";
import { publicChange, publicProject } from "./public";
import type { Change } from "./contracts";

test("browser project projection omits every execution argument including unknown secrets", () => {
  const project = publicProject({ id: "app", name: "App", root: "/fixture", createdAt: "now", components: [{ id: "web", name: "Web", kind: "native", cwd: "/fixture", dependsOn: [], argv: ["bun", "run", "--unknown", "SENTINEL_ARGV_SECRET"], health: { url: "http://127.0.0.1:5173", authorization: "SENTINEL_NESTED_SECRET" } as {url:string} }] });
  expect(JSON.stringify(project)).not.toContain("SENTINEL_ARGV_SECRET");
  expect("argv" in project.components[0]!).toBe(false);
  expect(JSON.stringify(project)).not.toContain("SENTINEL_NESTED_SECRET");
});
test("maintenance projection contains only image operands, never neighboring source secrets", () => {
  const change: Change = { id: "change", projectId: "app", componentId: "api", file: "Dockerfile", sourceHash: "hash", replacement: "php:8.4", state: "preview", createdAt: "now", original: "FROM php:8.3 # SENTINEL_COMMENT_SECRET\nENV TOKEN=SENTINEL_SOURCE_SECRET\n", proposed: "FROM php:8.4 # SENTINEL_COMMENT_SECRET\nENV TOKEN=SENTINEL_SOURCE_SECRET\n" };
  const projected = publicChange(change);
  expect(projected.changedLine).toEqual({ line: 1, before: "php:8.3", after: "php:8.4" });
  expect(JSON.stringify(projected)).not.toContain("SENTINEL");
  expect("original" in projected).toBe(false);
  expect(() => publicChange({ ...change, proposed: "RUN echo unsafe\nENV TOKEN=SENTINEL_SOURCE_SECRET\n" })).toThrow();
});
