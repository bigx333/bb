import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hashPluginServerSource,
  pluginServerCacheDirectory,
} from "../../../src/services/plugins/plugin-server-cache.js";

describe("plugin server cache", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("invalidates for source changes but ignores generated and dependency trees", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "bb-server-cache-hash-"));
    tempDirs.push(rootDir);
    await writeFile(join(rootDir, "server.ts"), "export default () => {};");
    const first = await hashPluginServerSource(rootDir);

    await mkdir(join(rootDir, "dist"));
    await mkdir(join(rootDir, "node_modules"));
    await writeFile(join(rootDir, "dist", "server.js"), "generated");
    await writeFile(join(rootDir, "node_modules", "dependency.js"), "ignored");
    expect(await hashPluginServerSource(rootDir)).toBe(first);

    await writeFile(join(rootDir, "server.ts"), "export default () => 1;");
    expect(await hashPluginServerSource(rootDir)).not.toBe(first);
  });

  it("keys entries by source, SDK, Node, plugin, and source location", () => {
    const base = {
      dataDir: "/data",
      pluginId: "example",
      rootDir: "/plugins/example",
      sourceDigest: "abc",
      sdkVersion: "0.4.0",
      bbVersion: "0.9.0",
      nodeVersion: "22.0.0",
    };
    const first = pluginServerCacheDirectory(base);

    expect(pluginServerCacheDirectory(base)).toBe(first);
    expect(
      pluginServerCacheDirectory({ ...base, sourceDigest: "def" }),
    ).not.toBe(first);
    expect(
      pluginServerCacheDirectory({ ...base, sdkVersion: "0.5.0" }),
    ).not.toBe(first);
    expect(
      pluginServerCacheDirectory({ ...base, bbVersion: "0.10.0" }),
    ).not.toBe(first);
    expect(
      pluginServerCacheDirectory({ ...base, nodeVersion: "23.0.0" }),
    ).not.toBe(first);
    expect(
      pluginServerCacheDirectory({ ...base, pluginId: "another" }),
    ).not.toBe(first);
    expect(
      pluginServerCacheDirectory({ ...base, rootDir: "/plugins/moved" }),
    ).not.toBe(first);
  });
});
