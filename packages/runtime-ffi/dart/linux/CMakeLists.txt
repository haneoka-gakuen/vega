cmake_minimum_required(VERSION 3.13)
project(vega_runtime_ffi LANGUAGES CXX)
get_filename_component(VEGA_PLUGIN_SOURCE "${CMAKE_CURRENT_SOURCE_DIR}" REALPATH)
get_filename_component(VEGA_WORKSPACE "${VEGA_PLUGIN_SOURCE}/../../../.." ABSOLUTE)
find_program(VEGA_CARGO_EXECUTABLE cargo REQUIRED)
set(VEGA_CARGO_TARGET "${CMAKE_CURRENT_BINARY_DIR}/rust")
set(VEGA_RUNTIME_LIBRARY "${VEGA_CARGO_TARGET}/release/libvega_runtime.so")
file(GLOB_RECURSE VEGA_RUST_SOURCES CONFIGURE_DEPENDS "${VEGA_WORKSPACE}/crates/*.rs")
add_custom_command(OUTPUT "${VEGA_RUNTIME_LIBRARY}"
  COMMAND "${VEGA_CARGO_EXECUTABLE}" build --release --locked -p vega-native
    --manifest-path "${VEGA_WORKSPACE}/Cargo.toml" --target-dir "${VEGA_CARGO_TARGET}"
  DEPENDS ${VEGA_RUST_SOURCES} "${VEGA_WORKSPACE}/Cargo.toml"
    "${VEGA_WORKSPACE}/Cargo.lock"
    "${VEGA_WORKSPACE}/crates/vega-core/Cargo.toml"
    "${VEGA_WORKSPACE}/crates/vega-native/Cargo.toml"
  VERBATIM)
add_custom_target(vega_runtime_kernel ALL DEPENDS "${VEGA_RUNTIME_LIBRARY}")
set(vega_runtime_ffi_bundled_libraries "${VEGA_RUNTIME_LIBRARY}" PARENT_SCOPE)
