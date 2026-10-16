require_relative '../apple/podspec'

Pod::Spec.new do |s|
  configure_vega_runtime(s)
  s.platform = :osx, '10.15'
  s.dependency 'FlutterMacOS'
end
