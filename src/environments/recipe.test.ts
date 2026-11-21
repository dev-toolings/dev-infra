import { expect, test } from "bun:test";
import { parseRecipe } from "./recipe";

const base = (extra: Record<string, unknown> = {}) => ({
  version: 1, repositories: { app: { path: "/srv/app", ref: "main" } },
  compose: { repository: "app", files: [{ repository: "app", path: "compose.yml" }] }, ...extra,
});

test("isolation defaults to shared and hardened keeps only Docker default capabilities", () => {
  expect(parseRecipe(base())).toMatchObject({ isolation: "shared", capabilities: {}, internet: [] });
  expect(parseRecipe(base({ isolation: "hardened", capabilities: { db: ["CHOWN"] }, internet: ["api"] })))
    .toMatchObject({ isolation: "hardened", capabilities: { db: ["CHOWN"] }, internet: ["api"] });
  expect(() => parseRecipe(base({ isolation: "hardened", capabilities: { db: ["SYS_ADMIN"] } }))).toThrow("Invalid capability");
});

test("only shared isolation uses shared resources, only hardened takes capabilities", () => {
  expect(() => parseRecipe(base({ isolation: "dedicated", shared: { networks: ["dev-shared-net"] } }))).toThrow("Only the shared isolation level");
  expect(() => parseRecipe(base({ isolation: "dedicated", internet: ["api"] }))).toThrow("hardened isolation level only");
  expect(() => parseRecipe(base({ isolation: "sandbox" }))).toThrow("Invalid isolation");
});
