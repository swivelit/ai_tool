cmake_minimum_required(VERSION 3.22.1)

# The verifier runs this CMake file before Expo prebuild. In that mode, avoid
# host compiler/toolchain probes and only exercise the llama.cpp path/guard
# resolution that release Android builds rely on. The normal build path below
# still creates and links libjai_llama_runtime.so.
set(JAI_LLAMA_CPP_DIR "" CACHE PATH "Path to a vendored llama.cpp checkout")
set(JAI_REQUIRE_LLAMA_CPP OFF CACHE BOOL "Fail configure when llama.cpp is missing")
set(JAI_VERIFY_LLAMA_CPP_CONFIGURE_ONLY OFF CACHE BOOL "Verify llama.cpp path guards without compiling native sources")

if(JAI_VERIFY_LLAMA_CPP_CONFIGURE_ONLY)
  project(jai_llama_runtime_verify LANGUAGES NONE)

  set(JAI_VERIFY_LLAMA_CPP_DIR "${JAI_LLAMA_CPP_DIR}")
  if(NOT JAI_VERIFY_LLAMA_CPP_DIR)
    if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/../../../../vendor/llama.cpp/CMakeLists.txt")
      get_filename_component(JAI_VERIFY_LLAMA_CPP_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../../../vendor/llama.cpp" ABSOLUTE)
    elseif(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/llama.cpp/CMakeLists.txt")
      set(JAI_VERIFY_LLAMA_CPP_DIR "${CMAKE_CURRENT_SOURCE_DIR}/llama.cpp")
    endif()
  elseif(NOT IS_ABSOLUTE "${JAI_VERIFY_LLAMA_CPP_DIR}")
    get_filename_component(JAI_VERIFY_LLAMA_CPP_DIR "${JAI_VERIFY_LLAMA_CPP_DIR}" ABSOLUTE BASE_DIR "${CMAKE_CURRENT_SOURCE_DIR}")
  endif()

  if(JAI_VERIFY_LLAMA_CPP_DIR AND EXISTS "${JAI_VERIFY_LLAMA_CPP_DIR}/CMakeLists.txt" AND EXISTS "${JAI_VERIFY_LLAMA_CPP_DIR}/include/llama.h")
    message(STATUS "JaiOnDeviceModel verify: llama.cpp present at ${JAI_VERIFY_LLAMA_CPP_DIR}; production build will set JAI_LLAMA_CPP_AVAILABLE=1")
  elseif(JAI_REQUIRE_LLAMA_CPP)
    message(FATAL_ERROR
      "JaiOnDeviceModel release/production native_on_device build requires llama.cpp at "
      "mobile/modules/jai-on-device-model/vendor/llama.cpp or -DJAI_LLAMA_CPP_DIR=/path/to/llama.cpp. "
      "Run `npm run native:sync-llama` from mobile/ or `git submodule update --init --recursive` before building."
    )
  else()
    message(WARNING "JaiOnDeviceModel verify: llama.cpp not found; only non-production dev builds may use JAI_LLAMA_CPP_AVAILABLE=0")
  endif()

  return()
endif()

project(jai_llama_runtime LANGUAGES C CXX)


add_library(jai_llama_runtime SHARED
  jai_llama_runtime.cpp
)

target_compile_features(jai_llama_runtime PRIVATE cxx_std_17)
target_include_directories(jai_llama_runtime PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})

# llama.cpp is optional only for local development/test scaffolds. Production
# release/production native_on_device builds must set JAI_REQUIRE_LLAMA_CPP=ON from Gradle/CI and
# must fail here if the vendored checkout is absent.
#
# Supported locations:
#   - mobile/modules/jai-on-device-model/vendor/llama.cpp
#   - mobile/modules/jai-on-device-model/android/src/main/cpp/llama.cpp
#   - -DJAI_LLAMA_CPP_DIR=/absolute/or/relative/path/to/llama.cpp
set(JAI_LLAMA_CPP_DIR "" CACHE PATH "Path to a vendored llama.cpp checkout")
set(JAI_REQUIRE_LLAMA_CPP OFF CACHE BOOL "Fail configure when llama.cpp is missing")

if(NOT JAI_LLAMA_CPP_DIR)
  if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/../../../../vendor/llama.cpp/CMakeLists.txt")
    get_filename_component(JAI_LLAMA_CPP_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../../../vendor/llama.cpp" ABSOLUTE)
  elseif(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/llama.cpp/CMakeLists.txt")
    set(JAI_LLAMA_CPP_DIR "${CMAKE_CURRENT_SOURCE_DIR}/llama.cpp")
  endif()
elseif(NOT IS_ABSOLUTE "${JAI_LLAMA_CPP_DIR}")
  get_filename_component(JAI_LLAMA_CPP_DIR "${JAI_LLAMA_CPP_DIR}" ABSOLUTE BASE_DIR "${CMAKE_CURRENT_SOURCE_DIR}")
endif()

set(JAI_LLAMA_CPP_FOUND OFF)
if(JAI_LLAMA_CPP_DIR AND EXISTS "${JAI_LLAMA_CPP_DIR}/CMakeLists.txt" AND EXISTS "${JAI_LLAMA_CPP_DIR}/include/llama.h")
  set(JAI_LLAMA_CPP_FOUND ON)
endif()

if(JAI_LLAMA_CPP_FOUND)
  message(STATUS "JaiOnDeviceModel: building with llama.cpp at ${JAI_LLAMA_CPP_DIR}")

  set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
  set(LLAMA_BUILD_TESTS OFF CACHE BOOL "" FORCE)
  set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
  set(LLAMA_BUILD_SERVER OFF CACHE BOOL "" FORCE)
  set(LLAMA_CURL OFF CACHE BOOL "" FORCE)
  set(GGML_NATIVE OFF CACHE BOOL "" FORCE)
  set(GGML_OPENMP OFF CACHE BOOL "" FORCE)
  set(GGML_LTO OFF CACHE BOOL "" FORCE)

  add_subdirectory("${JAI_LLAMA_CPP_DIR}" llama_cpp_build EXCLUDE_FROM_ALL)

  if(NOT TARGET llama)
    message(FATAL_ERROR "JaiOnDeviceModel: llama.cpp was found at ${JAI_LLAMA_CPP_DIR}, but its CMake target 'llama' was not created. Check the pinned llama.cpp revision.")
  endif()

  target_compile_definitions(jai_llama_runtime PRIVATE JAI_LLAMA_CPP_AVAILABLE=1)
  target_include_directories(jai_llama_runtime PRIVATE
    "${JAI_LLAMA_CPP_DIR}/include"
    "${JAI_LLAMA_CPP_DIR}/src"
    "${JAI_LLAMA_CPP_DIR}/ggml/include"
    "${JAI_LLAMA_CPP_DIR}/ggml/src"
  )
  target_link_libraries(jai_llama_runtime PRIVATE llama)
else()
  if(JAI_REQUIRE_LLAMA_CPP)
    message(FATAL_ERROR
      "JaiOnDeviceModel release/production native_on_device build requires llama.cpp at "
      "mobile/modules/jai-on-device-model/vendor/llama.cpp or -DJAI_LLAMA_CPP_DIR=/path/to/llama.cpp. "
      "Run `npm run native:sync-llama` from mobile/ or `git submodule update --init --recursive` before building."
    )
  endif()

  message(WARNING "JaiOnDeviceModel: llama.cpp not found; development native calls will throw JAI_LLAMA_CPP_BACKEND_MISSING")
  target_compile_definitions(jai_llama_runtime PRIVATE JAI_LLAMA_CPP_AVAILABLE=0)
endif()

find_library(log_lib log)
if(log_lib)
  target_link_libraries(jai_llama_runtime PRIVATE ${log_lib})
endif()
