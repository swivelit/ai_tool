require 'json'

Pod::Spec.new do |s|
  s.name           = 'JaiWakeWord'
  s.version        = '0.1.0'
  s.summary        = 'Jai OpenWakeWord native wake detection module'
  s.description    = 'Local Expo module for Jai wake-word detection.'
  s.author         = 'Harish Ajahan'
  s.homepage       = 'https://github.com/harishajahan/ai_tool'
  s.license        = { :type => 'UNLICENSED' }
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = "**/*.{h,m,mm,swift}"
end
