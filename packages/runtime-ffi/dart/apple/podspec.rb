def configure_vega_runtime(s)
  s.name = 'vega_runtime_ffi'
  s.version = '0.1.0'
  s.summary = 'Vega Rust execution core through the platform C ABI.'
  s.description = s.summary
  s.homepage = 'https://github.com/haneoka-gakuen/vega'
  s.license = { :type => 'MPL-2.0', :file => '../../../../LICENSE' }
  s.author = 'Vega contributors'
  s.source = { :path => '.' }
  s.source_files = 'Classes/*.c'
  s.static_framework = true
  symbols = %w[abi_version create destroy control observe begin admit complete reposition record]
  retain = symbols.map { |name| "-Wl,-u,_vega_execution_#{name}" }.join(' ')
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'ENABLE_USER_SCRIPT_SANDBOXING' => 'NO' }
  s.user_target_xcconfig = {
    'OTHER_LDFLAGS' => "$(inherited) #{retain} \"$(BUILT_PRODUCTS_DIR)/vega_runtime_ffi/libvega_runtime.a\""
  }
  s.script_phase = {
    :name => 'Build Vega Rust execution core',
    :script => '/bin/sh "${PODS_TARGET_SRCROOT}/../apple/build.sh"',
    :execution_position => :before_compile,
    :always_out_of_date => '1',
    :input_files => [File.realpath('build.sh', __dir__)] +
      Dir[File.expand_path('../../../../crates/{vega-core,vega-native}/**/*.{rs,toml}', __dir__)] +
      %w[Cargo.toml Cargo.lock].map { |name| File.expand_path("../../../../#{name}", __dir__) },
    :output_files => ['$(BUILT_PRODUCTS_DIR)/vega_runtime_ffi/libvega_runtime.a']
  }
end
