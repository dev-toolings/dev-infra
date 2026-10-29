import { expect, test } from "bun:test";
import { DevHubError, type Component } from "../contracts";
import { resolveSelection } from "./graph";

type GraphComponent = Pick<Component, "id" | "dependsOn">;

function expectInvalid(run: () => unknown): void {
  let error: unknown;
  try {
    run();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(DevHubError);
  expect(error).toMatchObject({ code: "invalid", status: 400 });
  expect((error as Error).message.length).toBeLessThanOrEqual(64);
}

test("selects the dependency closure in deterministic dependency-first order", () => {
  const components: GraphComponent[] = [
    { id: "web", dependsOn: ["api"] },
    { id: "worker", dependsOn: ["db"] },
    { id: "api", dependsOn: ["db", "cache"] },
    { id: "cache", dependsOn: [] },
    { id: "db", dependsOn: [] },
    { id: "unrelated", dependsOn: [] },
  ];

  expect(resolveSelection(components, ["web", "worker"])).toEqual({
    requested: ["web", "worker"],
    start: ["cache", "db", "api", "web", "worker"],
    stop: ["worker", "web"],
  });
});

test("omitted selection includes all components with stable sorted traversal", () => {
  const first: GraphComponent[] = [
    { id: "d", dependsOn: ["c"] },
    { id: "c", dependsOn: ["b", "a"] },
    { id: "b", dependsOn: [] },
    { id: "a", dependsOn: [] },
  ];
  const second = [...first].reverse();
  const expected = {
    requested: ["a", "b", "c", "d"],
    start: ["a", "b", "c", "d"],
    stop: ["d", "c", "b", "a"],
  };

  expect(resolveSelection(first)).toEqual(expected);
  expect(resolveSelection(second)).toEqual(expected);
});

test("normalizes duplicate dependency edges and returns fresh arrays", () => {
  const components: GraphComponent[] = [
    { id: "b", dependsOn: ["a", "a"] },
    { id: "a", dependsOn: [] },
  ];
  const first = resolveSelection(components, ["b"]);
  const second = resolveSelection(components, ["b"]);

  expect(first).toEqual({ requested: ["b"], start: ["a", "b"], stop: ["b"] });
  expect(first.requested).not.toBe(first.start);
  expect(first.start).not.toBe(first.stop);
  expect(first.requested).not.toBe(second.requested);
  expect(first.start).not.toBe(second.start);
  expect(first.stop).not.toBe(second.stop);
});

test("rejects empty, duplicate, and unknown explicit selections", () => {
  const components: GraphComponent[] = [{ id: "app", dependsOn: [] }];
  expectInvalid(() => resolveSelection(components, []));
  expectInvalid(() => resolveSelection(components, ["app", "app"]));
  expectInvalid(() => resolveSelection(components, ["missing"]));
});

test("rejects malformed graph arrays, entries, IDs, and dependency lists", () => {
  expectInvalid(() => resolveSelection(null as unknown as GraphComponent[]));
  expectInvalid(() => resolveSelection([]));
  expectInvalid(() => resolveSelection([null] as unknown as GraphComponent[]));
  expectInvalid(() => resolveSelection([{ id: "app", dependsOn: null }] as unknown as GraphComponent[]));
  expectInvalid(() => resolveSelection([{ id: "App", dependsOn: [] }]));
  expectInvalid(() => resolveSelection([{ id: "bad.id", dependsOn: [] }]));
  expectInvalid(() => resolveSelection([{ id: "app", dependsOn: [null] }] as unknown as GraphComponent[]));
  expectInvalid(() => resolveSelection([{ id: "app", dependsOn: [] }], null as unknown as string[]));
});

test("enforces component and dependency bounds while accepting 64 components", () => {
  expectInvalid(() => resolveSelection(Array.from({ length: 65 }, (_, index) => ({
    id: `c${index}`,
    dependsOn: [],
  }))));

  const sixtyFour = Array.from({ length: 64 }, (_, index) => ({ id: `c${index}`, dependsOn: [] }));
  expect(resolveSelection(sixtyFour).requested).toHaveLength(64);
  expect(resolveSelection([{ id: `a${"b".repeat(63)}`, dependsOn: [] }]).requested).toHaveLength(1);
  expectInvalid(() => resolveSelection([{ id: `a${"b".repeat(64)}`, dependsOn: [] }]));

  expectInvalid(() => resolveSelection([
    { id: "root", dependsOn: [] },
    { id: "child", dependsOn: Array.from({ length: 65 }, () => "root") },
  ]));
});

test("rejects duplicate component IDs and dependency references that are invalid", () => {
  expectInvalid(() => resolveSelection([
    { id: "app", dependsOn: [] },
    { id: "app", dependsOn: [] },
  ]));
  expectInvalid(() => resolveSelection([{ id: "app", dependsOn: ["missing"] }]));
  expectInvalid(() => resolveSelection([{ id: "app", dependsOn: ["app"] }]));
});

test("rejects cycles anywhere in the project, including outside the selection", () => {
  expectInvalid(() => resolveSelection([
    { id: "app", dependsOn: [] },
    { id: "cycle_a", dependsOn: ["cycle_b"] },
    { id: "cycle_b", dependsOn: ["cycle_a"] },
  ], ["app"]));
});

test("does not mutate frozen inputs", () => {
  const dependencies = Object.freeze(["base"]);
  const components = Object.freeze([
    Object.freeze({ id: "app", dependsOn: dependencies }),
    Object.freeze({ id: "base", dependsOn: Object.freeze([]) }),
  ]) as unknown as readonly GraphComponent[];

  expect(resolveSelection(components, Object.freeze(["app"]))).toEqual({
    requested: ["app"],
    start: ["base", "app"],
    stop: ["app"],
  });
  expect(components[0]!.dependsOn).toEqual(["base"]);
});
