import { expect, test } from "bun:test";
import { execCommand } from "./executor";
test("executor rejects excess output and enforces a finite deadline", async () => {
  await expect(execCommand([process.execPath, "--eval", "process.stdout.write('x'.repeat(65536))"], { maxOutputBytes: 64 })).rejects.toThrow("output exceeded");
  await expect(execCommand([process.execPath, "--eval", "setTimeout(()=>{},10000)"], { timeoutMs: 20 })).rejects.toThrow("timed out");
});
