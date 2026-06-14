#!/usr/bin/env bash
set -euo pipefail

prefix="${PREFIX:-$HOME/.local}"
bin_dir="${BIN_DIR:-$prefix/bin}"
install_dir="${INSTALL_DIR:-$prefix/lib/relaymux}"
repo_url="${RELAYMUX_REPO_URL:-https://github.com/avyayv/relaymux.git}"
ref="${RELAYMUX_REF:-main}"
work_dir=""

usage() {
  cat <<'USAGE'
Install relaymux with a local build and a shell shim.

Usage:
  ./install.sh [--prefix <dir>] [--bin-dir <dir>] [--install-dir <dir>]
  curl -fsSL https://raw.githubusercontent.com/avyayv/relaymux/main/install.sh | bash

Environment:
  PREFIX             Base install prefix. Default: ~/.local
  BIN_DIR            Directory for the relaymux shim. Default: $PREFIX/bin
  INSTALL_DIR        Directory for app files. Default: $PREFIX/lib/relaymux
  RELAYMUX_REPO_URL  Git repo to clone when run outside a checkout.
  RELAYMUX_REF       Git ref to install when cloning. Default: main
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix)
      prefix="$2"
      bin_dir="${BIN_DIR:-$prefix/bin}"
      install_dir="${INSTALL_DIR:-$prefix/lib/relaymux}"
      shift 2
      ;;
    --bin-dir)
      bin_dir="$2"
      shift 2
      ;;
    --install-dir)
      install_dir="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "relaymux install: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "relaymux install: missing required command: $1" >&2
    exit 1
  fi
}

need node
need npm

if [[ -f package.json && -d src && -d bin ]]; then
  src_dir="$PWD"
else
  need git
  work_dir="$(mktemp -d)"
  trap '[[ -n "$work_dir" ]] && rm -rf "$work_dir"' EXIT
  git clone --depth 1 --branch "$ref" "$repo_url" "$work_dir/relaymux" >/dev/null
  src_dir="$work_dir/relaymux"
fi

cd "$src_dir"
npm ci
npm run build

rm -rf "$install_dir"
mkdir -p "$install_dir" "$bin_dir"
cp -R dist package.json README.md LICENSE examples scripts "$install_dir/"

cat > "$bin_dir/relaymux" <<SHIM
#!/usr/bin/env sh
exec node "$install_dir/dist/bin/relaymux.js" "\$@"
SHIM
chmod +x "$bin_dir/relaymux"

cat <<EOF
relaymux installed to $install_dir
CLI shim written to $bin_dir/relaymux

If needed, add this to your shell profile:
  export PATH="$bin_dir:\$PATH"

Next:
  relaymux --version
  relaymux setup
  relaymux status

Optional adapters:
  relaymux setup --imsg --chat-id <chat-id-or-phone-number>
  relaymux setup --telegram --telegram-chat-id <chat-id>
EOF
