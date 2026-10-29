import { describe, expect, test } from "bun:test";
import { DevHubError } from "../contracts";
import { classifyManifests, parseMakeTargets } from "./manifests";

describe("classifyManifests", () => {
  test("classifies PHP frameworks and JavaScript tools in fixed order", () => {
    const composer = {
      require: {
        "laravel/framework": "^11.0",
        "symfony/framework-bundle": "^7.0",
      },
    };
    const packageJson = {
      dependencies: { vite: "^6.0" },
      devDependencies: { react: "^19.0" },
    };

    expect(classifyManifests(packageJson, composer)).toEqual([
      "php", "symfony", "laravel", "node", "react", "vite",
    ]);
  });

  test("uses plain manifests as language evidence without framework false positives", () => {
    expect(classifyManifests(undefined, {
      require: {
        "symfony/polyfill-mbstring": "^1.0",
        "illuminate/database": "^11.0",
      },
    })).toEqual(["php"]);
    expect(classifyManifests({ scripts: { build: "vite" }, env: "ignored" }, null)).toEqual(["node"]);
  });

  test("accepts null-prototype records, own exact keys, and bounded string versions", () => {
    const composerRequire = Object.assign(Object.create(null), {
      "symfony/framework-bundle": "v".repeat(512),
      "laravel/framework": 12,
    });
    const packageDependencies = Object.assign(Object.create(null), {
      react: "^19.0",
      vite: "v".repeat(513),
    });

    expect(classifyManifests({ dependencies: packageDependencies }, { require: composerRequire })).toEqual([
      "php", "symfony", "node", "react",
    ]);
  });

  test("ignores malformed, inherited, array, and non-string dependency data", () => {
    const inheritedPackage = Object.create({ dependencies: { react: "^19.0" } });
    const inheritedDependencies = Object.create({ vite: "^6.0" });
    const packageJson = { dependencies: inheritedDependencies, devDependencies: [] };
    const composerJson = { require: { "laravel/framework": "" }, "require-dev": null };
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();

    expect(classifyManifests(inheritedPackage, composerJson)).toEqual(["php"]);
    expect(classifyManifests([], { require: { "symfony/framework-bundle": "^7.0" } })).toEqual(["php", "symfony"]);
    expect(classifyManifests({ dependencies: packageJson.dependencies }, ["not", "a", "manifest"])).toEqual(["node"]);
    expect(classifyManifests(revoked.proxy, null)).toEqual([]);
    expect(classifyManifests(null, null)).toEqual([]);
  });

  test("does not mutate metadata and does not expose versions or script fields", () => {
    const packageJson = Object.freeze({
      dependencies: Object.freeze({ react: "secret-version" }),
      scripts: Object.freeze({ build: "secret-command" }),
    });
    const composerJson = Object.freeze({
      require: Object.freeze({ "laravel/framework": "secret-version" }),
      scripts: Object.freeze({ "post-install-cmd": "secret-command" }),
    });
    const beforePackage = JSON.stringify(packageJson);
    const beforeComposer = JSON.stringify(composerJson);

    expect(classifyManifests(packageJson, composerJson)).toEqual(["php", "laravel", "node", "react"]);
    expect(JSON.stringify(packageJson)).toBe(beforePackage);
    expect(JSON.stringify(composerJson)).toBe(beforeComposer);
  });
});

describe("parseMakeTargets", () => {
  test("indexes explicit targets in file order and ignores recipes and comments", () => {
    const makefile = [
      "# ignored: comment",
      "  all build: deps # trailing comment",
      "\t@echo ignored: recipe",
      "clean:: output",
      ".PHONY: all clean",
      "build: another-dependency",
      "",
    ].join("\n");

    expect(parseMakeTargets(makefile)).toEqual({ targets: ["all", "build", "clean"], truncated: false });
  });

  test("ignores assignments, dynamic names, patterns, and unsupported continuations", () => {
    const makefile = [
      "A := value",
      "B ::= value",
      "C :::= value",
      "target: CFLAGS := value",
      "%.o: %.c",
      "$(DYNAMIC): deps",
      "${DYNAMIC}: deps",
      "first hidden \\",
      "also-hidden: deps \\",
      "hidden-too: deps",
      "visible: deps",
    ].join("\n");

    expect(parseMakeTargets(makefile)).toEqual({ targets: ["visible"], truncated: false });
  });

  test("handles CRLF and double-colon rules", () => {
    expect(parseMakeTargets("one two:: deps\r\nthree: deps\r\n")).toEqual({
      targets: ["one", "two", "three"],
      truncated: false,
    });
  });

  test("deduplicates targets and caps the result at one hundred", () => {
    const firstHundred = Array.from({ length: 100 }, (_, index) => `target${index}`);
    const makefile = [...firstHundred.map((target) => `${target}:`), "target0:", "target100:"].join("\n");
    const result = parseMakeTargets(makefile);

    expect(result.targets).toEqual(firstHundred);
    expect(result.truncated).toBe(true);
  });

  test("measures the one mebibyte input limit in UTF-8 bytes", () => {
    const exactLimit = `#${"é".repeat(524287)}\n`;
    expect(parseMakeTargets(exactLimit)).toEqual({ targets: [], truncated: false });
    expect(parseMakeTargets(`${exactLimit}\n`)).toEqual({ targets: [], truncated: true });
  });

  test("rejects non-string runtime input with an invalid 400 error", () => {
    try {
      parseMakeTargets(4 as unknown as string);
      throw new Error("expected parseMakeTargets to reject non-string input");
    } catch (error) {
      expect(error).toBeInstanceOf(DevHubError);
      expect((error as DevHubError).code).toBe("invalid");
      expect((error as DevHubError).status).toBe(400);
    }
  });
});
