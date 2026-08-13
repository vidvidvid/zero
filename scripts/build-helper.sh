#!/bin/sh
# Builds zero-voice, the Swift helper behind voice memos. Tauri picks the result
# up as a sidecar, which is why the name carries the target triple; the binary
# itself is never committed.
#
# Needs swiftc and the macOS 26 SDK. Memos need macOS 26 at runtime too.
set -e

cd "$(dirname "$0")/.."

src="helper/zero-voice.swift"
out="src-tauri/binaries/zero-voice-aarch64-apple-darwin"

# swiftc has no notion of being up to date, and this script is chained in front
# of every `tauri dev` and every `tauri build`. Without the timestamp check,
# every launch would pay for a compile nothing asked for. The script itself is
# in the check too: a flag changed here is a different binary.
if [ -f "$out" ] && [ "$out" -nt "$src" ] && [ "$out" -nt "$0" ]; then
	exit 0
fi

mkdir -p src-tauri/binaries
echo "building $out" >&2
# The target is pinned, not inherited: a bare swiftc stamps the binary with the
# build host's OS as its floor, so building on a future macOS would silently
# lock out the macOS 26 machines the feature is for.
swiftc -O -parse-as-library -target arm64-apple-macos26.0 "$src" -o "$out"
