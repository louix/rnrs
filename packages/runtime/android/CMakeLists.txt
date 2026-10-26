# librnrs.so: the framework's generic JSI adapter and lifecycle scope, linked with the app's Rust
# modules: their prebuilt archives and, for modules the app builds from source
# (rustNativeApp.sourceBuild), its source bundle. `rnrs build --target android` (the
# rnrsLinkModules Gradle task) writes the module list and registry to RNRS_LINK_DIR first.
cmake_minimum_required(VERSION 3.22.1)
project(rnrs)
set(CMAKE_CXX_STANDARD 20)

find_package(fbjni REQUIRED CONFIG)
find_package(ReactAndroid REQUIRED CONFIG)

if(ANDROID_ABI STREQUAL "arm64-v8a")
  set(RNRS_TRIPLE aarch64-linux-android)
elseif(ANDROID_ABI STREQUAL "armeabi-v7a")
  set(RNRS_TRIPLE armv7-linux-androideabi)
elseif(ANDROID_ABI STREQUAL "x86")
  set(RNRS_TRIPLE i686-linux-android)
elseif(ANDROID_ABI STREQUAL "x86_64")
  set(RNRS_TRIPLE x86_64-linux-android)
else()
  message(FATAL_ERROR "rnrs: unsupported ABI ${ANDROID_ABI}")
endif()
# Sets RNRS_MODULE_ARCHIVES (this ABI's prebuilt archives), RNRS_MODULE_LINK_LIBRARIES and
# RNRS_SOURCE_BUNDLE. Not fatal at configure time: an IDE sync can configure CMake before the
# Gradle task ran (every Gradle build runs it before the CMake tasks; compiling without it
# fails in RnrsRegistry.cpp). CMake reconfigures when the generated file changes.
set(RNRS_MODULES_CMAKE "${RNRS_LINK_DIR}/modules.cmake")
if(EXISTS "${RNRS_MODULES_CMAKE}")
  include("${RNRS_MODULES_CMAKE}")
else()
  message(WARNING "rnrs: ${RNRS_MODULES_CMAKE} is not generated yet; the rnrsLinkModules Gradle task writes it before compiling")
endif()
set(RNRS_RUST_LIBS ${RNRS_MODULE_ARCHIVES})
if(RNRS_SOURCE_BUNDLE)
  set(RNRS_BUNDLE_LIB "${RNRS_LINK_DIR}/target/${RNRS_TRIPLE}/release/librnrs_bundle.a")
  if(NOT EXISTS "${RNRS_BUNDLE_LIB}")
    message(WARNING "rnrs: the source bundle ${RNRS_BUNDLE_LIB} is not built yet; the rnrsLinkModules Gradle task builds it before compiling")
  endif()
  list(APPEND RNRS_RUST_LIBS "${RNRS_BUNDLE_LIB}")
endif()

# Platform-independent framework C++ (JSI adapter, runtime scope, bindings) is shared with
# iOS in ../cpp; src/main/jni holds only the JNI side.
file(GLOB rnrs_sources CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/src/main/jni/*.cpp" "${CMAKE_CURRENT_SOURCE_DIR}/../cpp/*.cpp")
add_library(rnrs SHARED ${rnrs_sources})
target_include_directories(rnrs PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/../cpp" "${RNRS_LINK_DIR}")
target_compile_options(rnrs PRIVATE -frtti -fexceptions -Wall -Werror)
option(RNRS_TEST_HOOKS "Compile the native test hooks (device test harnesses only)" OFF)
if(RNRS_TEST_HOOKS)
  target_compile_definitions(rnrs PRIVATE RNRS_TEST_HOOKS=1)
endif()
# 16 KB page sizes (Android 15+ devices): React Native (0.83.1 to 0.88.0) sets flexible page sizes only
# for com.android.application modules, and this is a library, so librnrs.so (which also
# contains the app's Rust modules) is linked with 16 KB segment alignment here. NDK 27 or
# lower needs both flags (developer.android.com/guide/practices/page-sizes); 4 KB devices
# load such libraries unchanged.
target_link_options(rnrs PRIVATE "-Wl,-z,max-page-size=16384" "-Wl,-z,common-page-size=16384")
# Attribution counters (Gradle -Prnrs.diagnostics=true; never for measurements).
if(RNRS_DIAGNOSTICS)
  target_compile_definitions(rnrs PRIVATE RNRS_DIAGNOSTICS=1)
endif()
target_link_libraries(rnrs
  ${RNRS_RUST_LIBS}
  ${RNRS_MODULE_LINK_LIBRARIES}
  ReactAndroid::jsi
  ReactAndroid::reactnative
  fbjni::fbjni
  android
  log
  dl
  m)
