// Metro config for the Jungle mobile app living inside the npm-workspaces monorepo.
// Two non-obvious things it must do:
//   1. Watch the workspace root so Metro can bundle @jungle/shared's TS source, and
//      resolve modules from both mobile/node_modules and the hoisted root node_modules.
//   2. Pin react to mobile's own copy. frontend/ pulls a slightly newer React that
//      hoists to the root while mobile's exact-pinned React (what Expo/RN requires)
//      nests in mobile/node_modules; RN must see exactly one React or hooks break
//      ("Invalid hook call"). react-native itself has a single hoisted copy, so it
//      needs no pin — nodeModulesPaths resolves it. See the plan's risk #1.
//   3. @jungle/shared is uncompiled TS whose internal imports use explicit ".js"
//      extensions (ESM-with-TS style). Vite/tsx map those to ".ts" automatically;
//      Metro does not, so we rewrite ".js" -> ".ts" for requests originating inside
//      shared/src.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "..");
const sharedSrc = path.join(workspaceRoot, "shared", "src");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

config.resolver.extraNodeModules = {
  react: path.resolve(projectRoot, "node_modules/react"),
};

// Respect @jungle/shared's package "exports" map ("." -> "./src/index.ts").
config.resolver.unstable_enablePackageExports = true;

// Rewrite explicit ".js" imports to ".ts" when they originate inside shared/src,
// where every file is actually TypeScript.
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    moduleName.startsWith(".") &&
    moduleName.endsWith(".js") &&
    context.originModulePath.startsWith(sharedSrc)
  ) {
    moduleName = moduleName.slice(0, -3) + ".ts";
  }
  const resolve = defaultResolveRequest || context.resolveRequest;
  return resolve(context, moduleName, platform);
};

module.exports = config;
