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
  s.libraries = 'c++'
  s.frameworks = 'Accelerate'
  s.resources = []

  llama_dir = File.expand_path('../vendor/llama.cpp', __dir__)
  llama_header = File.join(llama_dir, 'include', 'llama.h')
  prebuilt_libs = Dir[File.join(llama_dir, 'build-ios', '**', 'lib*.a')]

  s.source_files = [
    '**/*.{h,m,mm,swift}',
  ]
  s.public_header_files = '**/*.h'

  header_search_paths = [
    '$(PODS_TARGET_SRCROOT)',
  ]

  if File.exist?(llama_header)
    s.preserve_paths = [
      '../vendor/llama.cpp/**/*',
    ]

    header_search_paths += [
      '$(PODS_TARGET_SRCROOT)/../vendor/llama.cpp/include',
      '$(PODS_TARGET_SRCROOT)/../vendor/llama.cpp/src',
      '$(PODS_TARGET_SRCROOT)/../vendor/llama.cpp/ggml/include',
      '$(PODS_TARGET_SRCROOT)/../vendor/llama.cpp/ggml/src',
      '$(PODS_TARGET_SRCROOT)/../vendor/llama.cpp/ggml/src/ggml-cpu',
    ]

    if prebuilt_libs.any?
      s.vendored_libraries = prebuilt_libs.map do |path|
        path.sub(File.expand_path('..', __dir__) + '/', '../')
      end
    else
      s.source_files += [
        '../vendor/llama.cpp/include/**/*.h',
        '../vendor/llama.cpp/src/**/*.{c,cc,cpp,h,hpp}',
        '../vendor/llama.cpp/ggml/include/**/*.h',
        '../vendor/llama.cpp/ggml/src/**/*.{c,cc,cpp,h,hpp}',
      ]
      s.exclude_files = [
        '../vendor/llama.cpp/src/**/*-cuda*',
        '../vendor/llama.cpp/src/**/*-vulkan*',
        '../vendor/llama.cpp/src/**/*-sycl*',
        '../vendor/llama.cpp/src/**/*-kompute*',
        '../vendor/llama.cpp/src/**/*-rpc*',
        '../vendor/llama.cpp/ggml/src/**/*-cuda*',
        '../vendor/llama.cpp/ggml/src/**/*-vulkan*',
        '../vendor/llama.cpp/ggml/src/**/*-sycl*',
        '../vendor/llama.cpp/ggml/src/**/*-kompute*',
        '../vendor/llama.cpp/ggml/src/**/*-rpc*',
        '../vendor/llama.cpp/ggml/src/ggml-vulkan/**/*',
        '../vendor/llama.cpp/ggml/src/ggml-cuda/**/*',
        '../vendor/llama.cpp/ggml/src/ggml-sycl/**/*',
        '../vendor/llama.cpp/ggml/src/ggml-kompute/**/*',
        '../vendor/llama.cpp/ggml/src/ggml-rpc/**/*',
        '../vendor/llama.cpp/examples/**/*',
        '../vendor/llama.cpp/tools/**/*',
        '../vendor/llama.cpp/tests/**/*',
      ]
    end

    s.pod_target_xcconfig = {
      'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
      'CLANG_CXX_LIBRARY' => 'libc++',
      'HEADER_SEARCH_PATHS' => header_search_paths.map { |path| '"' + path + '"' }.join(' '),
      'GCC_PREPROCESSOR_DEFINITIONS' => '$(inherited) JAI_LLAMA_CPP_AVAILABLE=1 GGML_USE_ACCELERATE=1 GGML_USE_CPU=1',
      'OTHER_CPLUSPLUSFLAGS' => '$(inherited) -fexceptions -frtti',
    }
  else
    s.pod_target_xcconfig = {
      'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
      'CLANG_CXX_LIBRARY' => 'libc++',
      'HEADER_SEARCH_PATHS' => header_search_paths.map { |path| '"' + path + '"' }.join(' '),
      'GCC_PREPROCESSOR_DEFINITIONS' => '$(inherited) JAI_LLAMA_CPP_AVAILABLE=0',
      'OTHER_CPLUSPLUSFLAGS' => '$(inherited) -fexceptions -frtti',
    }
  end
end
