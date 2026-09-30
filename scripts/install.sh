#!/usr/bin/env sh
# Installs the walrus binary onto PATH (~/.local/bin). Run after `bun run build`.
set -e
root=$(cd "$(dirname "$0")/.." && pwd)
exe="$root/dist/walrus"
[ -f "$exe" ] || { echo "Build first: bun run build" >&2; exit 1; }

bin="${XDG_BIN_HOME:-$HOME/.local/bin}"
mkdir -p "$bin" "$HOME/.walrus/skills" "$HOME/.walrus/agents"
cp "$exe" "$bin/walrus"
chmod +x "$bin/walrus"
echo "installed $bin/walrus"

case ":$PATH:" in
  *":$bin:"*) ;;
  *) echo "add $bin to your PATH, e.g.: echo 'export PATH=\"$bin:\$PATH\"' >> ~/.profile" ;;
esac
