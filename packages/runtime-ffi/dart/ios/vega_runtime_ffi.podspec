require_relative '../apple/podspec'

Pod::Spec.new do |s|
  configure_vega_runtime(s)
  s.platform = :ios, '15.0'
  s.dependency 'Flutter'
end
