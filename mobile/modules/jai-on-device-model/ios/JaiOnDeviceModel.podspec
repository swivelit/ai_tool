require 'pathname'

Pod::Spec.new do |s|
  s.name           = 'JaiOnDeviceModel'
  s.version        = '0.1.0'
  s.summary        = 'Local-only Gemma/Qwen on-device inference bridge for Swico.'
  s.description    = 'Expo module bridge for local llama.cpp GGUF inference. It does not call backend/OpenAI.'
  s.author         = 'Swico'
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

  module_root = File.expand_path('..', __dir__)
  default_llama_dir = File.join(module_root, 'vendor', 'llama.cpp')
  llama_dir = File.expand_path(ENV.fetch('JAI_LLAMA_CPP_DIR', default_llama_dir))
  llama_spec_path = Pathname.new(llama_dir).relative_path_from(Pathname.new(__dir__)).to_s
  llama_header = File.join(llama_dir, 'include', 'llama.h')
  llama_cmake = File.join(llama_dir, 'CMakeLists.txt')
  has_llama_cpp = File.exist?(llama_header) && File.exist?(llama_cmake)
  prebuilt_libs = has_llama_cpp ? Dir[File.join(llama_dir, 'build-ios', '**', 'lib*.a')] : []
  has_linkable_llama_cpp = prebuilt_libs.any?

  normalize_env = lambda { |value| value.to_s.strip.downcase }
  truthy_env = lambda { |value| %w[1 true yes y on].include?(normalize_env.call(value)) }
  runtime_mode = normalize_env.call(ENV.fetch('EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE', 'native_on_device'))
  eas_build_profile = normalize_env.call(ENV.fetch('EAS_BUILD_PROFILE', ''))
  jai_build_profile = normalize_env.call(ENV.fetch('JAI_BUILD_PROFILE', ''))
  jai_build_type = normalize_env.call(ENV['JAI_BUILD_TYPE'] || ENV['BUILD_TYPE'])
  explicit_require_llama_cpp = truthy_env.call(ENV['JAI_REQUIRE_LLAMA_CPP'])
  production_or_release_build =
    %w[production release].include?(eas_build_profile) ||
    %w[production release].include?(jai_build_profile) ||
    jai_build_type == 'release' ||
    explicit_require_llama_cpp
  production_native_on_device = production_or_release_build && runtime_mode == 'native_on_device'

  if runtime_mode == 'local_adapter' && production_or_release_build
    raise <<~MSG
      local_adapter is development-only.
      Release/production iOS builds must use EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE=native_on_device.
    MSG
  end

  if production_native_on_device && !has_linkable_llama_cpp
    raise <<~MSG
      Release/production native_on_device iOS build requires prebuilt llama.cpp static libraries under #{File.join(default_llama_dir, 'build-ios')} or JAI_LLAMA_CPP_DIR/build-ios.
      Build or copy the iOS llama.cpp static libraries before pod install/build.
      Refusing to compile with JAI_LLAMA_CPP_AVAILABLE=0.
    MSG
  end

  source_files = [
    '**/*.{h,m,mm,swift}',
  ]

  header_search_paths = [
    '$(PODS_TARGET_SRCROOT)',
  ]

  if has_linkable_llama_cpp
    s.preserve_paths = [
      File.join(llama_spec_path, '**/*'),
    ]

    header_search_paths += [
      "$(PODS_TARGET_SRCROOT)/#{llama_spec_path}/include",
      "$(PODS_TARGET_SRCROOT)/#{llama_spec_path}/src",
      "$(PODS_TARGET_SRCROOT)/#{llama_spec_path}/ggml/include",
      "$(PODS_TARGET_SRCROOT)/#{llama_spec_path}/ggml/src",
      "$(PODS_TARGET_SRCROOT)/#{llama_spec_path}/ggml/src/ggml-cpu",
    ]

    s.vendored_libraries = prebuilt_libs.map do |lib|
      lib.start_with?(module_root + '/') ? lib.sub(module_root + '/', '../') : lib
    end

    s.pod_target_xcconfig = {
      'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
      'CLANG_CXX_LIBRARY' => 'libc++',
      'HEADER_SEARCH_PATHS' => header_search_paths.map { |path| '"' + path + '"' }.join(' '),
      'GCC_PREPROCESSOR_DEFINITIONS' => '$(inherited) JAI_LLAMA_CPP_AVAILABLE=1 GGML_USE_ACCELERATE=1 GGML_USE_CPU=1',
      'OTHER_CFLAGS' => '$(inherited) -DGGML_USE_ACCELERATE=1 -DGGML_USE_CPU=1',
      'OTHER_CPLUSPLUSFLAGS' => '$(inherited) -fexceptions -frtti -DGGML_USE_ACCELERATE=1 -DGGML_USE_CPU=1',
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

  s.source_files = source_files
  s.public_header_files = '**/*.h'
end
