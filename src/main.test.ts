import { expect, test } from "bun:test";
import { listen, LISTEN_HOST } from "./main";
test("controller explicitly binds loopback and rejects invalid ports", () => {
  let binding: { hostname: string; port: number } | undefined;
  listen(() => new Response("ok"), 8040, (options) => { binding = options; return {}; });
  expect(binding).toMatchObject({ hostname: "127.0.0.1", port: 8040 });
  expect(LISTEN_HOST).toBe("127.0.0.1");
  expect(() => listen(() => new Response(), 80, () => ({}))).toThrow();
});
