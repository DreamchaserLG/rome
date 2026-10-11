#!/usr/bin/env bash
set -euo pipefail

# Installs an app whose approved dependency is a C++ addon, the way the daemon
# installs apps: as rome, through the image's pinned pnpm (pnpmEnv in
# packages/core/src/apps/packaging/pack.ts). Run inside the production image by
# check-runtime-closure.mjs.
#
# The addon has a binding.gyp and no install script, so pnpm runs its implicit
# `node-gyp rebuild`, the same path a prebuild-shipping package such as
# better-sqlite3 takes. That needs make before it builds anything, then g++ to
# compile addon.cc. NPM_CONFIG_NODEDIR points node-gyp at the headers the Node
# image ships, so the check needs no network. The name is upper-case because
# pnpm strips a lower-case npm_config_nodedir from a lifecycle script's
# environment.

dir="$(mktemp -d)"
mkdir "$dir/addon" "$dir/app"

cat >"$dir/addon/package.json" <<'JSON'
{ "name": "rome-native-addon-check", "version": "1.0.0", "main": "build/Release/addon.node" }
JSON
cat >"$dir/addon/binding.gyp" <<'GYP'
{ "targets": [{ "target_name": "addon", "sources": ["addon.cc"] }] }
GYP
cat >"$dir/addon/addon.cc" <<'CC'
#include <node_api.h>

static napi_value Init(napi_env env, napi_value exports) {
  napi_value answer;
  napi_create_int32(env, 42, &answer);
  napi_set_named_property(env, exports, "answer", answer);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
CC

cat >"$dir/app/package.json" <<'JSON'
{ "name": "native-addon-check", "private": true, "dependencies": { "rome-native-addon-check": "file:../addon" } }
JSON
cat >"$dir/app/pnpm-workspace.yaml" <<'YAML'
allowBuilds:
  "rome-native-addon-check@file:../addon": true
YAML

cd "$dir/app"
if ! COREPACK_HOME="$ROME_PNPM_COREPACK_HOME" COREPACK_DEFAULT_TO_LATEST=0 \
  NPM_CONFIG_NODEDIR=/usr/local pnpm install --offline; then
  echo "Native addon build failed: the production image lacks the node-gyp toolchain (python3, make, g++)" >&2
  exit 1
fi
node -e 'if (require("rome-native-addon-check").answer !== 42) process.exit(1)' || {
  echo "Native addon built but did not load" >&2
  exit 1
}
echo "Native addon build check passed."
