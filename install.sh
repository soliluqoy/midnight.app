#!/bin/sh
# midnight installer for macOS (Apple silicon) and Linux (x86_64). Per-user, no sudo:
#   curl -fsSL https://raw.githubusercontent.com/soliluqoy/midnight.app/main/install.sh | sh
# Uninstall:
#   curl -fsSL https://raw.githubusercontent.com/soliluqoy/midnight.app/main/install.sh | sh -s -- --uninstall
set -eu

REPO="soliluqoy/midnight.app"
BASE="https://github.com/$REPO/releases/latest/download"
OS=$(uname -s)
ARCH=$(uname -m)
UNINSTALL=0
[ "${1:-}" = "--uninstall" ] && UNINSTALL=1

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || die "curl is required"

case "$OS" in
Darwin)
	APP="$HOME/Applications/midnight.app"
	pkill -x midnight 2>/dev/null || true
	if [ "$UNINSTALL" = 1 ]; then
		rm -rf "$APP"
		say "midnight removed. Settings stay in ~/Library/Application Support/midnight; sign-ins in ~/.midnight.server."
		exit 0
	fi
	[ "$ARCH" = "arm64" ] || die "midnight for macOS needs Apple silicon (M1 or later)."
	TMP=$(mktemp -d)
	trap 'rm -rf "$TMP"' EXIT
	say "Downloading midnight..."
	curl -fL --progress-bar "$BASE/midnight-mac-arm64.zip" -o "$TMP/midnight.zip"
	say "Installing to $APP ..."
	mkdir -p "$HOME/Applications"
	rm -rf "$APP"
	ditto -x -k "$TMP/midnight.zip" "$HOME/Applications"
	[ -d "$APP" ] || die "the download did not contain midnight.app"
	# Not notarized yet: clear quarantine and sign ad hoc so Apple silicon will run it.
	xattr -cr "$APP" 2>/dev/null || true
	codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
	open "$APP"
	say ""
	say "midnight is installed and running (menu bar icon, pill at the bottom of the screen)."
	say "Summon it with Cmd+Alt+M. Desktop control (computer use) is Windows-only for now; search, reading and the browser work."
	;;
Linux)
	DIR="$HOME/.local/share/midnight"
	BIN="$HOME/.local/bin"
	DESK="$HOME/.local/share/applications/midnight.desktop"
	pkill -f "$DIR/midnight.AppImage" 2>/dev/null || true
	if [ "$UNINSTALL" = 1 ]; then
		rm -rf "$DIR" "$BIN/midnight" "$DESK"
		say "midnight removed. Settings stay in ~/.config/midnight; sign-ins in ~/.midnight.server."
		exit 0
	fi
	[ "$ARCH" = "x86_64" ] || die "midnight for Linux is x86_64 only for now."
	mkdir -p "$DIR" "$BIN" "$(dirname "$DESK")"
	say "Downloading midnight..."
	curl -fL --progress-bar "$BASE/midnight-linux-x64.AppImage" -o "$DIR/midnight.AppImage.part"
	mv "$DIR/midnight.AppImage.part" "$DIR/midnight.AppImage"
	chmod +x "$DIR/midnight.AppImage"
	ln -sf "$DIR/midnight.AppImage" "$BIN/midnight"
	cat >"$DESK" <<EOF
[Desktop Entry]
Name=midnight
Comment=A desktop capsule that searches, reads and works in plain view
Exec=$DIR/midnight.AppImage
Terminal=false
Type=Application
Categories=Utility;
EOF
	if ! ldconfig -p 2>/dev/null | grep -q libfuse.so.2; then
		say "note: AppImages need libfuse2 (Ubuntu/Debian: sudo apt install libfuse2t64 || sudo apt install libfuse2)."
	fi
	nohup "$DIR/midnight.AppImage" >/dev/null 2>&1 &
	say ""
	say "midnight is installed: run 'midnight' (make sure ~/.local/bin is on your PATH) or find it in your app menu."
	say "Summon it with Ctrl+Alt+M. Desktop control (computer use) is Windows-only for now; search, reading and the browser work."
	;;
*)
	die "unsupported system: $OS (use install.ps1 on Windows)"
	;;
esac
