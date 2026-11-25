#!/usr/bin/env bash
# Build in disposable native source checkouts. Paths may contain spaces.
set -euo pipefail
if [[ $# != 3 ]]; then
  echo "usage: build-media.sh X264_CHECKOUT FFMPEG_CHECKOUT OUTPUT_DIR" >&2
  exit 2
fi
x264=$(cd "$1" && pwd)
ffmpeg=$(cd "$2" && pwd)
mkdir -p "$3/bin" "$3/licenses"
output=$(cd "$3" && pwd)
test "$(git -C "$x264" rev-parse HEAD)" = 31e19f92f00c7003fa115047ce50978bc98c3a0d
test "$(git -C "$ffmpeg" rev-parse HEAD)" = 38b88335f99e76ed89ff3c93f877fdefce736c13
deps=$(mktemp -d)
trap 'rm -rf "$deps"' EXIT
jobs=${BUILD_JOBS:-4}
cd "$x264"
./configure --prefix="$deps" --enable-static --enable-pic --disable-opencl --disable-cli
make -j"$jobs"
make install
cd "$ffmpeg"
export PKG_CONFIG_PATH="$deps/lib/pkgconfig"
platform_flags=()
case "$(uname -s)" in
  MINGW*|MSYS*) platform_flags+=(--extra-ldflags=-static) ;;
esac
./configure --disable-autodetect --disable-shared --enable-static --disable-debug \
  --disable-doc --disable-network --disable-ffplay --enable-gpl --enable-libx264 --enable-zlib \
  --pkg-config-flags=--static ${platform_flags[@]+"${platform_flags[@]}"}
make -j"$jobs"
for tool in ffmpeg ffprobe; do
  suffix=""
  if [[ -f "$tool.exe" ]]; then suffix=.exe; fi
  cp "$tool$suffix" "$output/bin/"
  "$output/bin/$tool$suffix" -version
done
cp "$ffmpeg/COPYING.GPLv2" "$output/licenses/FFmpeg-GPLv2.txt"
cp "$x264/COPYING" "$output/licenses/x264-GPLv2.txt"
