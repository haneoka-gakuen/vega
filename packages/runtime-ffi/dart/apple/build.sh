#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
workspace=$(CDPATH= cd -- "$script_dir/../../../.." && pwd -P)
cargo=${VEGA_CARGO_EXECUTABLE:-cargo}
target_dir="$DERIVED_FILE_DIR/vega-rust"
artifact_dir="$BUILT_PRODUCTS_DIR/vega_runtime_ffi"
mkdir -p "$artifact_dir"

case "$PLATFORM_NAME" in
  iphoneos) sdk=iphoneos ;;
  iphonesimulator) sdk=iphonesimulator ;;
  macosx) sdk=macosx ;;
  *) echo "Unsupported Vega Apple SDK: $PLATFORM_NAME" >&2; exit 1 ;;
esac
export SDKROOT=$(xcrun --sdk "$sdk" --show-sdk-path)
linker=$(xcrun --sdk "$sdk" --find clang)
export CARGO_BUILD_JOBS=1

set --
for arch in $ARCHS; do
  case "$sdk:$arch" in
    iphoneos:arm64) target=aarch64-apple-ios ;;
    iphonesimulator:arm64) target=aarch64-apple-ios-sim ;;
    iphonesimulator:x86_64) target=x86_64-apple-ios ;;
    macosx:arm64) target=aarch64-apple-darwin ;;
    macosx:x86_64) target=x86_64-apple-darwin ;;
    *) echo "Unsupported Vega Apple architecture: $sdk/$arch" >&2; exit 1 ;;
  esac
  linker_key=$(printf '%s' "$target" | tr '[:lower:]-' '[:upper:]_')
  env "CARGO_TARGET_${linker_key}_LINKER=$linker" "$cargo" build \
    --release --locked -p vega-native --manifest-path "$workspace/Cargo.toml" \
    --target "$target" --target-dir "$target_dir"
  set -- "$@" "$target_dir/$target/release/libvega_runtime.a"
done
xcrun lipo -create "$@" -output "$artifact_dir/libvega_runtime.a"
