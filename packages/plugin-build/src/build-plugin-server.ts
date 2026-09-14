import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createPluginArtifactMeta } from "./plugin-artifact-meta.js";
import { zodLocaleStubPlugin } from "./zod-locale-stub.mjs";
import { zodResolutionPlugin } from "./zod-resolution.js";
import {
  isRecord,
  readPluginPackageJsonFile,
  resolveManifestEntryFile,
  validatePluginBuildManifest,
} from "./plugin-manifest.js";
import {
  describeUnresolvedSdkImport,
  PLUGIN_SDK_PACKAGE_NAME,
} from "./plugin-sdk-install.js";
import {
  NODE_ESM_REQUIRE_BANNER,
  type PluginBuildToolchain,
} from "./toolchain.js";

const LEGACY_PLUGIN_SDK_SPECIFIER = "@bb/plugin-sdk";

export const PLUGIN_SERVER_EXTERNALS: readonly string[] = [
  PLUGIN_SDK_PACKAGE_NAME,
  LEGACY_PLUGIN_SDK_SPECIFIER,
  "better-sqlite3",
];

const PLUGIN_SDK_ROOT_FILTER = /^@get-bb\/plugin-sdk$|^@bb\/plugin-sdk$/;
const PLUGIN_SDK_SUBPATH_FILTER = /^@get-bb\/plugin-sdk\//;
const PLUGIN_SDK_SUBPATH_RESOLVE_MARK = "bb-server-sdk-subpath";
const PLUGIN_RUNTIME_FALLBACK_RESOLVE_MARK = "bb-server-runtime-fallback";
const PLUGIN_SOURCE_BOUNDARY_RESOLVE_MARK = "bb-server-source-boundary";
const BARE_PACKAGE_FILTER = /^[^./]|^@[^/]+\/[^/]+/;
const ABSOLUTE_FILE_IMPORT_FILTER = /^\//;

interface PluginServerConfig {
  serverEntry: string;
  packageName: string;
  pluginVersion: string;
}

async function readPluginServerConfig(
  rootDir: string,
): Promise<PluginServerConfig> {
  const packageJsonPath = join(rootDir, "package.json");
  const json = await readPluginPackageJsonFile(packageJsonPath);
  if (!isRecord(json) || !isRecord(json.bb) || json.bb.server === undefined) {
    throw new Error(
      `no server entry: ${packageJsonPath} has no "bb": { "server": "./server.ts" } field`,
    );
  }
  const manifest = await validatePluginBuildManifest(
    json,
    rootDir,
    packageJsonPath,
  );
  const serverEntry = await resolveManifestEntryFile(
    rootDir,
    manifest.bb.server,
    "bb.server",
  );
  return {
    serverEntry,
    packageName: manifest.name,
    pluginVersion: manifest.version,
  };
}

interface PluginServerBuildResult {
  jsPath: string;
  mapPath: string;
  metaPath: string;
}

export interface PluginServerBuildOptions {
  hostProvidedZod?: boolean;
  outDir?: string;
  validatedConfig?: PluginServerConfig;
  runtimeImports?: Record<string, { path: string; external?: boolean }>;
  fallbackResolve?: (specifier: string) => string | undefined;
  preserveSourceImportMetaUrl?: boolean;
  externalizeSourceOutsideRoot?: boolean;
  externalizeBareImports?: boolean;
}

function loaderForSourcePath(path: string): "js" | "jsx" | "ts" | "tsx" {
  const extension = extname(path);
  if (extension === ".ts" || extension === ".mts" || extension === ".cts") {
    return "ts";
  }
  if (extension === ".tsx") return "tsx";
  if (extension === ".jsx") return "jsx";
  return "js";
}

export async function buildPluginServer(
  rootDir: string,
  bbVersion: string,
  toolchain: PluginBuildToolchain,
  options: PluginServerBuildOptions = {},
): Promise<PluginServerBuildResult> {
  const { serverEntry, packageName, pluginVersion } =
    options.validatedConfig ?? (await readPluginServerConfig(rootDir));
  const sourceRoot = await realpath(rootDir);
  const distDir = options.outDir ?? join(rootDir, "dist");
  await mkdir(distDir, { recursive: true });
  const jsPath = join(distDir, "server.js");
  const mapPath = join(distDir, "server.js.map");
  const metaPath = join(distDir, "server.meta.json");

  const stageDir = await mkdtemp(join(distDir, ".stage-"));
  try {
    const stagedJsPath = join(stageDir, "server.js");
    const stagedMetaPath = join(stageDir, "server.meta.json");

    const esbuild = (await import(
      toolchain.esbuild
    )) as typeof import("esbuild");
    const runtimeImports = options.runtimeImports ?? {};
    await esbuild.build({
      entryPoints: [serverEntry],
      outfile: stagedJsPath,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      sourcemap: true,
      sourcesContent: false,
      banner: { js: NODE_ESM_REQUIRE_BANNER },
      external: PLUGIN_SERVER_EXTERNALS.filter(
        (specifier) =>
          !PLUGIN_SDK_ROOT_FILTER.test(specifier) &&
          runtimeImports[specifier] === undefined,
      ).concat(
        Object.values(runtimeImports)
          .filter((entry) => entry.external === true)
          .map((entry) => entry.path),
      ),
      minify: true,
      keepNames: true,
      plugins: [
        zodResolutionPlugin("server", {
          hostProvidedBareZod: options.hostProvidedZod,
        }),
        zodLocaleStubPlugin(),
        ...(options.preserveSourceImportMetaUrl === true
          ? [
              {
                name: "bb-plugin-source-url",
                setup(build: import("esbuild").PluginBuild) {
                  build.onLoad(
                    { filter: /\.(?:[cm]?[jt]s|[jt]sx)$/ },
                    async (args: import("esbuild").OnLoadArgs) => ({
                      contents: (await readFile(args.path, "utf8")).replace(
                        /\bimport\.meta\.url\b/g,
                        JSON.stringify(pathToFileURL(args.path).href),
                      ),
                      loader: loaderForSourcePath(args.path),
                    }),
                  );
                },
              },
            ]
          : []),
        {
          name: "bb-plugin-sdk-resolution",
          setup(build) {
            for (const [specifier, entry] of Object.entries(runtimeImports)) {
              const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
              build.onResolve({ filter: new RegExp(`^${escaped}$`) }, () => ({
                path: entry.path,
                external: entry.external === true,
              }));
            }
            build.onResolve({ filter: PLUGIN_SDK_ROOT_FILTER }, (args) => ({
              path: args.path,
              external: true,
            }));
            build.onResolve(
              { filter: PLUGIN_SDK_SUBPATH_FILTER },
              async (args) => {
                if (args.pluginData === PLUGIN_SDK_SUBPATH_RESOLVE_MARK) {
                  return undefined;
                }
                const installed = await build.resolve(args.path, {
                  resolveDir: args.resolveDir,
                  kind: args.kind,
                  importer: args.importer,
                  pluginData: PLUGIN_SDK_SUBPATH_RESOLVE_MARK,
                });
                if (installed.errors.length === 0 && installed.path !== "") {
                  return { path: installed.path };
                }
                return {
                  errors: [
                    {
                      text: await describeUnresolvedSdkImport({
                        specifier: args.path,
                        resolveDir: args.resolveDir,
                        need: `a server entry's "${args.path}" import is bundled from the plugin's own SDK install (bb serves only the bare "${PLUGIN_SDK_PACKAGE_NAME}" at load time), so the plugin needs`,
                        esbuildErrors: installed.errors,
                      }),
                    },
                  ],
                };
              },
            );
            build.onResolve({ filter: BARE_PACKAGE_FILTER }, async (args) => {
              if (
                args.pluginData === PLUGIN_RUNTIME_FALLBACK_RESOLVE_MARK ||
                PLUGIN_SDK_SUBPATH_FILTER.test(args.path) ||
                options.fallbackResolve === undefined
              ) {
                return undefined;
              }
              const installed = await build.resolve(args.path, {
                resolveDir: args.resolveDir,
                kind: args.kind,
                importer: args.importer,
                pluginData: PLUGIN_RUNTIME_FALLBACK_RESOLVE_MARK,
              });
              if (installed.errors.length === 0 && installed.path !== "") {
                return {
                  path: installed.path,
                  external:
                    options.externalizeBareImports === true ||
                    installed.path.startsWith("node:"),
                };
              }
              const fallback = options.fallbackResolve(args.path);
              return fallback === undefined || fallback.startsWith("node:")
                ? undefined
                : {
                    path: fallback,
                    external: options.externalizeBareImports === true,
                  };
            });
            if (options.externalizeSourceOutsideRoot === true) {
              build.onResolve(
                { filter: ABSOLUTE_FILE_IMPORT_FILTER },
                async (args) => {
                  if (
                    args.importer === "" ||
                    args.kind === "entry-point" ||
                    args.pluginData === PLUGIN_SOURCE_BOUNDARY_RESOLVE_MARK
                  ) {
                    return undefined;
                  }
                  const resolved = await build.resolve(args.path, {
                    resolveDir: args.resolveDir,
                    kind: args.kind,
                    importer: args.importer,
                    pluginData: PLUGIN_SOURCE_BOUNDARY_RESOLVE_MARK,
                  });
                  if (resolved.errors.length > 0 || resolved.path === "") {
                    return undefined;
                  }
                  const fromRoot = relative(sourceRoot, resolved.path);
                  if (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`)) {
                    return { path: resolved.path };
                  }
                  return { path: resolved.path, external: true };
                },
              );
            }
          },
        },
      ],
      logLevel: "error",
    });
    await writeFile(
      stagedMetaPath,
      JSON.stringify(
        createPluginArtifactMeta({ packageName, pluginVersion, bbVersion }),
        null,
        2,
      ) + "\n",
    );

    await rename(stagedJsPath, jsPath);
    await rename(join(stageDir, "server.js.map"), mapPath);
    await rename(stagedMetaPath, metaPath);
  } finally {
    await rm(stageDir, { recursive: true, force: true });
  }
  return { jsPath, mapPath, metaPath };
}
