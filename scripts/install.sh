#!/bin/sh
# NetMount headless CLI installer (Linux / macOS).
#
#   curl -fsSL https://raw.githubusercontent.com/2233admin/NetMount/feat/headless-cli/scripts/install.sh | sh
#
# Downloads the standalone CLI binary for your platform from the latest GitHub
# release that has CLI assets and drops it on your PATH. The binary embeds the
# Bun runtime, so no bun/node is required. On first use the CLI fetches rclone +
# openlist into ~/.netmount/bin/ automatically.
set -eu

REPO="2233admin/NetMount"
BIN="netmount"

os=$(uname -s)
case "$os" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) echo "unsupported OS: $os" >&2; exit 1 ;;
esac

arch=$(uname -m)
case "$arch" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "unsupported arch: $arch" >&2; exit 1 ;;
esac

asset="netmount-${os}-${arch}"
echo "Resolving $asset from latest $REPO release with CLI assets..."
url=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases" \
  | grep -o "https://github.com/${REPO}/releases/download/[^\"]*/${asset}" \
  | head -n1)
if [ -z "$url" ]; then
  echo "No $asset asset found. Has a cli-v* release been published yet?" >&2
  exit 1
fi

if [ -w /usr/local/bin ] 2>/dev/null; then
  dir=/usr/local/bin
else
  dir="$HOME/.local/bin"
  mkdir -p "$dir"
fi

tmp=$(mktemp)
echo "Downloading $url"
curl -fSL "$url" -o "$tmp"
chmod +x "$tmp"
mv "$tmp" "$dir/$BIN"
echo "Installed -> $dir/$BIN"

case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "NOTE: $dir is not on PATH. Add it:  export PATH=\"$dir:\$PATH\"" ;;
esac
echo "Run:  $BIN --help"
