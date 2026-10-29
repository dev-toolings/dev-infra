import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, lstatSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Catalog } from "./index";
import type { ProjectInput } from "../contracts";

let base = "";
let catalog: Catalog;
let projectRoot: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "devhub-catalog-"));
  mkdirSync(join(base,"infra")); mkdirSync(join(base,"roots"));
  projectRoot = join(base,"roots","app"); mkdirSync(projectRoot,{recursive:true}); mkdirSync(join(base,"roots","live"));
  catalog = new Catalog({stateDir:join(base,"state"),infraDir:join(base,"infra")});
  catalog.addRoot(join(base,"roots"),"Fixtures");
});
afterEach(() => { catalog?.close(); if (base) rmSync(base,{recursive:true,force:true}); });

function project(id = "app"): ProjectInput {
  return { id,name:"Fixture app",root:projectRoot,components:[{id:"web",name:"Web",kind:"native",cwd:projectRoot,argv:["bun","run","serve"],dependsOn:[]}] };
}

describe("Catalog", () => {
  test("rejects root traversal and symlink escapes", () => {
    expect(() => catalog.assertAllowedPath(join(base,"outside"),false)).toThrow();
    const outside = join(base,"outside"); mkdirSync(outside);
    const link = join(projectRoot,"escape"); symlinkSync(outside,link);
    expect(() => catalog.assertAllowedPath(join(link,"missing"),false)).toThrow();
  });

  test("persists project and record metadata across reopen", () => {
    catalog.createProject(project());
    catalog.putRecord("logs","cursor",{seq:4});
    catalog.close();
    catalog = new Catalog({stateDir:join(base,"state"),infraDir:join(base,"infra")});
    expect(catalog.getProject("app").components[0]?.id).toBe("web");
    expect(catalog.getRecord("logs","cursor")).toEqual({seq:4});
  });

  test("rejects missing dependencies and cycles", () => {
    const missing = project(); missing.components[0]!.dependsOn=["ghost"];
    expect(() => catalog.createProject(missing)).toThrow();
    const cycle = project(); cycle.components=[
      {id:"one",name:"One",kind:"native",cwd:projectRoot,argv:["run"],dependsOn:["two"]},
      {id:"two",name:"Two",kind:"native",cwd:projectRoot,argv:["run"],dependsOn:["one"]},
    ];
    expect(() => catalog.createProject(cycle)).toThrow();
  });

  test("claims one active operation and reuses a matching idempotency key", () => {
    catalog.createProject(project());
    const claimed = catalog.claimOperation("app","start",["web"],"run-1");
    const duplicate = catalog.claimOperation("app","start",["web"],"run-1");
    expect(claimed.acquired).toBe(true);
    expect(duplicate.acquired).toBe(false);
    expect(duplicate.operation.id).toBe(claimed.operation.id);
    expect(() => catalog.claimOperation("app","stop",["web"],"run-1")).toThrow();
    expect(() => catalog.claimOperation("app","stop",["web"])).toThrow();
    catalog.updateOperation(claimed.operation.id,{state:"running"});
    catalog.updateOperation(claimed.operation.id,{state:"succeeded"});
    expect(catalog.claimOperation("app","start",["web"],"run-1").acquired).toBe(false);
  });

  test("rejects shared infrastructure Compose identity", () => {
    writeFileSync(join(projectRoot,"compose.yml"),"services: {}\n");
    for (const projectName of ["infra-postgres","INFRA-Postgres"]) {
      const input = project(); input.components=[{id:"db",name:"Database",kind:"compose",cwd:projectRoot,dependsOn:[],compose:{files:["compose.yml"],projectName,profiles:[],services:["postgres"]}}];
      expect(() => catalog.createProject(input)).toThrow();
    }
  });

  test("rejects URL port collisions across projects", () => {
    const first = project(); first.components[0]!.url="http://127.0.0.1:8123/";
    catalog.createProject(first);
    const secondRoot = join(base,"roots","second"); mkdirSync(secondRoot);
    const second = project("second"); second.root=secondRoot; second.components[0]!.cwd=secondRoot; second.components[0]!.url="http://localhost:8123/";
    expect(() => catalog.createProject(second)).toThrow();
  });

  test("allows callback reads and rolls back callback failures", () => {
    catalog.createProject(project());
    expect(catalog.updateRecord("log-state","app",() => ({project:catalog.getProject("app").id}))).toEqual({project:"app"});
    expect(() => catalog.updateRecord("log-state","broken",() => { throw new Error("fixture"); })).toThrow("fixture");
    expect(catalog.getRecord("log-state","broken")).toBeUndefined();
    expect(() => catalog.updateRecord("log-state","nested",() => { catalog.putRecord("log-state","inner",1); return 2; })).toThrow();
    expect(catalog.getRecord("log-state","inner")).toBeUndefined();
  });

  test("keeps operation errors redacted and rejects terminal reversal", () => {
    catalog.createProject(project());
    const op = catalog.claimOperation("app","start",["web"]).operation;
    catalog.updateOperation(op.id,{state:"running"});
    const failed = catalog.updateOperation(op.id,{state:"failed",error:"password=hunter2 https://user:secret@example.test token=abc"});
    expect(failed.error).not.toContain("hunter2");
    expect(failed.error).not.toContain("secret@");
    expect(failed.error).not.toContain("token=abc");
    expect(() => catalog.updateOperation(op.id,{state:"running"})).toThrow();
  });

  test("restricts state and SQLite modes", () => {
    const state = join(base,"state");
    expect(lstatSync(state).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(state,"catalog.sqlite")).mode & 0o777).toBe(0o600);
  });
  test("recovers only operations whose owner process is gone", () => {
    catalog.createProject(project("dead")); catalog.createProject({ ...project("live"), root: join(base, "roots", "live"), components: [{ ...project().components[0]!, cwd: join(base, "roots", "live") }] });
    const dead = catalog.claimOperation("dead", "start", ["web"]).operation;
    const live = catalog.claimOperation("live", "start", ["web"]).operation;
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
    const raw = new Database(join(base, "state", "catalog.sqlite"));
    raw.query("UPDATE operations SET owner_pid=?, owner_start='1' WHERE id=?").run(2 ** 22 + 7, dead.id);
    raw.close();
    catalog.recoverOperations();
    expect(catalog.getOperation(dead.id).state).toBe("unknown");
    expect(catalog.getOperation(live.id).state).toBe("queued");
  });
});
