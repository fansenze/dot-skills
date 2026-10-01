#!/usr/bin/env bash
set -euo pipefail
umask 077
FEISHU_ROOT="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
FEISHU_NODE="${FEISHU_NODE:-node}"
# Dependency debug output can contain signed URLs or authorization headers.
unset DEBUG NODE_DEBUG
if ! command -v "$FEISHU_NODE" >/dev/null 2>&1; then
  printf '%s\n' 'Node.js is missing. Install Node.js 22.18+ and npm, then run feishu.sh setup.' >&2
  exit 2
fi
"$FEISHU_NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22 || (a===22&&b<18)){console.error("Node.js 22.18+ is required");process.exit(2)}'
if [[ "${1:-}" == setup ]]; then
  cd -- "$FEISHU_ROOT"
  exec npm ci --ignore-scripts --no-audit --no-fund --cache "$FEISHU_ROOT/.cache/npm"
fi
if [[ ! -d "$FEISHU_ROOT/node_modules/@larksuiteoapi/node-sdk" || ! -d "$FEISHU_ROOT/node_modules/yaml" || ! -d "$FEISHU_ROOT/node_modules/proxy-agent" ]]; then
  printf '%s\n' 'Node dependencies are missing. Run: bash /path/to/feishu-message-server/feishu.sh setup' >&2
  exit 2
fi
case "${1:-}" in
  test) exec "$FEISHU_NODE" --disable-warning=ExperimentalWarning --test "$FEISHU_ROOT"/tests/*.test.mjs ;;
  validate) exec "$FEISHU_NODE" "$FEISHU_ROOT/scripts/validate.mjs" ;;
  package) shift; exec "$FEISHU_NODE" "$FEISHU_ROOT/scripts/package.mjs" "$@" ;;
  *) exec "$FEISHU_NODE" --disable-warning=ExperimentalWarning "$FEISHU_ROOT/scripts/server.mjs" "$@" ;;
esac
