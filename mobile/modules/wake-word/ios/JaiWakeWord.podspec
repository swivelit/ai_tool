require 'json'

Pod::Spec.new do |s|
  s.name           = 'JaiWakeWord'
  s.version        = '0.1.0'
  s.summary        = 'Jai OpenWakeWord native wake detection module'
  s.description    = 'Local Expo module scaffold for on-device OpenWakeWord wake detection.'
  s.author         = 'Jai'
  s.homepage       = 'https://example.invalid/jai-wake-word'
  s.license        = { :type => 'UNLICENSED' }
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { :git => 'https://example.invalid/jai-wake-word.git', :tag => s.version.to_s }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = "**/*.{h,m,mm,swift}"
end
