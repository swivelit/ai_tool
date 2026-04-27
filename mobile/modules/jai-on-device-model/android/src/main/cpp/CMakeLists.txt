cmake_minimum_required(VERSION 3.22.1)

project(jai_llama_runtime LANGUAGES CXX)

add_library(jai_llama_runtime SHARED
  jai_llama_runtime.cpp
)

target_compile_features(jai_llama_runtime PRIVATE cxx_std_17)

target_include_directories(jai_llama_runtime PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})

# Build-ready llama.cpp seam.
#
# To finish real on-device inference, vendor llama.cpp under one of these paths
# or pass -DJAI_LLAMA_CPP_DIR=/absolute/path/to/llama.cpp from Gradle/CMake:
#   mobile/modules/jai-on-device-model/android/src/main/cpp/llama.cpp
#   mobile/modules/jai-on-device-model/vendor/llama.cpp
#
# Then replace the JAI_LLAMA_CPP_BACKEND_MISSING branches in
# jai_llama_runtime.cpp with real llama_model_load_from_file,
# llama_tokenize, llama_decode, sampling, max-token handling, context-size,
# thread-count, and embedding extraction calls. Keep the exported JNI function
# names stable because JaiLlamaCppBinding.kt calls them directly.
set(JAI_LLAMA_CPP_DIR "" CACHE PATH "Path to a vendored llama.cpp checkout")

if(NOT JAI_LLAMA_CPP_DIR)
  if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/llama.cpp/CMakeLists.txt")
    set(JAI_LLAMA_CPP_DIR "${CMAKE_CURRENT_SOURCE_DIR}/llama.cpp")
  elseif(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/../../../../vendor/llama.cpp/CMakeLists.txt")
    set(JAI_LLAMA_CPP_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../../../vendor/llama.cpp")
  endif()
endif()

if(JAI_LLAMA_CPP_DIR AND EXISTS "${JAI_LLAMA_CPP_DIR}/CMakeLists.txt")
  set(LLAMA_BUILD_TESTS OFF CACHE BOOL "" FORCE)
  set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
  set(LLAMA_BUILD_SERVER OFF CACHE BOOL "" FORCE)
  add_subdirectory("${JAI_LLAMA_CPP_DIR}" llama_cpp_build)
  target_compile_definitions(jai_llama_runtime PRIVATE JAI_LLAMA_CPP_AVAILABLE=1)
  target_include_directories(jai_llama_runtime PRIVATE "${JAI_LLAMA_CPP_DIR}/include" "${JAI_LLAMA_CPP_DIR}/common")
  target_link_libraries(jai_llama_runtime PRIVATE llama)
else()
  target_compile_definitions(jai_llama_runtime PRIVATE JAI_LLAMA_CPP_AVAILABLE=0)
endif()

find_library(log-lib log)

target_link_libraries(jai_llama_runtime PRIVATE ${log-lib})
