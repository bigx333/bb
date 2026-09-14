import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readlink, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  buildPluginServer,
  isIgnoredPluginDevPath,
  PLUGIN_TOOLCHAIN_PINS,
  type PluginBuildToolchain,
} from "@bb/plugin-build";

const PLUGIN_SERVER_RUNTIME_FORMAT_VERSION = 3;

async function hashFile(
  path: string,
  hash: ReturnType<typeof createHash>,
): Promise<void> {
  for await (const chunk of createReadStream(path)) hash.update(chunk);
}

export async function hashPluginServerSource(rootDir: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath =
        prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (isIgnoredPluginDevPath(relativePath)) continue;
      const path = join(directory, entry.name);
      const stats = await lstat(path);
      if (stats.isDirectory()) {
        hash.update(`d\0${relativePath}\0`);
        await visit(path, relativePath);
      } else if (stats.isSymbolicLink()) {
        hash.update(`l\0${relativePath}\0${await readlink(path)}\0`);
      } else if (stats.isFile()) {
        hash.update(`f\0${relativePath}\0${stats.mode & 0o777}\0`);
        await hashFile(path, hash);
      }
    }
  }
  await visit(rootDir, "");
  return hash.digest("hex");
}

export function pluginServerCacheDirectory(args: {
  dataDir: string;
  pluginId: string;
  rootDir: string;
  sourceDigest: string;
  sdkVersion: string;
  bbVersion: string;
  nodeVersion?: string;
}): string {
  const key = createHash("sha256")
    .update(
      JSON.stringify({
        sourceDigest: args.sourceDigest,
        rootDir: args.rootDir,
        sdkVersion: args.sdkVersion,
        bbVersion: args.bbVersion,
        nodeVersion: args.nodeVersion ?? process.versions.node,
        formatVersion: PLUGIN_SERVER_RUNTIME_FORMAT_VERSION,
        toolchain: PLUGIN_TOOLCHAIN_PINS,
      }),
    )
    .digest("hex");
  const pluginKey = createHash("sha256").update(args.pluginId).digest("hex");
  return join(args.dataDir, "plugins", "runtime", "server", pluginKey, key);
}

async function isCompleteCacheEntry(directory: string): Promise<boolean> {
  const files = ["server.js", "server.js.map", "server.meta.json"];
  const states = await Promise.all(
    files.map((file) =>
      stat(join(directory, file))
        .then((value) => value.isFile())
        .catch(() => false),
    ),
  );
  return states.every(Boolean);
}

export async function buildCachedPluginServer(args: {
  rootDir: string;
  cacheDir: string;
  bbVersion: string;
  toolchain: () => Promise<PluginBuildToolchain>;
  runtimeImports: Record<string, { path: string; external?: boolean }>;
  fallbackResolve: (specifier: string) => string | undefined;
}): Promise<string> {
  if (!(await isCompleteCacheEntry(args.cacheDir))) {
    await buildPluginServer(
      args.rootDir,
      args.bbVersion,
      await args.toolchain(),
      {
        outDir: args.cacheDir,
        runtimeImports: args.runtimeImports,
        fallbackResolve: args.fallbackResolve,
        preserveSourceImportMetaUrl: true,
        externalizeSourceOutsideRoot: true,
        externalizeBareImports: true,
      },
    );
  }
  return join(args.cacheDir, "server.js");
}
