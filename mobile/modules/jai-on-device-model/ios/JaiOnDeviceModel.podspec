Pod::Spec.new do |s|
  s.name           = 'JaiOnDeviceModel'
  s.version        = '0.1.0'
  s.summary        = 'Local-only Gemma/Qwen on-device inference bridge for J AI.'
  s.description    = 'Expo module bridge for local llama.cpp GGUF inference. It does not call backend/OpenAI.'
  s.author         = 'J AI'
  s.homepage       = 'https://example.invalid/jai-on-device-model'
  s.license        = { :type => 'UNLICENSED' }
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { :git => 'https://example.invalid/jai-on-device-model.git', :tag => s.version.to_s }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.{h,m,mm,swift}'
  s.public_header_files = '**/*.h'
  s.libraries = 'c++'
  s.resources = []
end
