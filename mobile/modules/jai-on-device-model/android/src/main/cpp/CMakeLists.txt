cmake_minimum_required(VERSION 3.22.1)

project(jai_llama_runtime LANGUAGES CXX)

add_library(jai_llama_runtime SHARED
  jai_llama_runtime.cpp
)

target_compile_features(jai_llama_runtime PRIVATE cxx_std_17)

target_include_directories(jai_llama_runtime PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})

# TODO: Add llama.cpp sources or a prebuilt llama.cpp package here, then link it
# into jai_llama_runtime. Keep the exported JNI function names in
# jai_llama_runtime.cpp stable because JaiLlamaCppBinding.kt calls them directly.
find_library(log-lib log)

target_link_libraries(jai_llama_runtime PRIVATE ${log-lib})
