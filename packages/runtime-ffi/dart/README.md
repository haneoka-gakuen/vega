# Vega platform execution driver

The Dart driver calls the source-neutral execution core in this Vega repository.
Linux and Windows build `vega-native` through CMake. Android builds arm64-v8a,
armeabi-v7a and x86_64 libraries before Gradle packages the plugin's JNI libraries.
iOS and macOS build a static archive for Xcode's selected architectures, then
link all public execution entry points into the application for
`DynamicLibrary.process()`.

Android loads `libvega_runtime.so` from its packaged native-library namespace.
The Rust linker aligns every ABI's load segments to 16 KiB.

Install Cargo and Rust 1.88 or later. Android requires NDK 28.2.13676358 and Rust
targets `aarch64-linux-android`, `armv7-linux-androideabi`,
`x86_64-linux-android`. Apple builds require Xcode and the selected Rust targets:
`aarch64-apple-ios` for devices, `aarch64-apple-ios-sim` or
`x86_64-apple-ios` for simulators, and `aarch64-apple-darwin` or
`x86_64-apple-darwin` for macOS. Set `VEGA_CARGO_EXECUTABLE` when Cargo is outside
the build environment's PATH; standard `CARGO_HOME` and `RUSTUP_HOME` select an
isolated Rust installation.

Use this package from the Vega repository checkout. Its build files resolve the
Vega workspace relative to the package; they never read application source.
Generated libraries stay in Gradle, CMake or Xcode build directories. No binary
provisioning or application-local library path is needed.

The Apple implementation follows the application's CocoaPods integration. Xcode
must be available to compile and link Apple targets.
