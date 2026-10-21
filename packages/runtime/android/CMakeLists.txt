# librnr.so: the framework's generic JSI adapter and lifecycle scope, linked with the app's
# generated Rust bundle (built by `rnrs build --target android` before this configures).
cmake_minimum_required(VERSION 3.22.1)
project(rnr)
set(CMAKE_CXX_STANDARD 20)

find_package(fbjni REQUIRED CONFIG)
find_package(ReactAndroid REQUIRED CONFIG)

if(ANDROID_ABI STREQUAL "arm64-v8a")
  set(RNR_TRIPLE aarch64-linux-android)
elseif(ANDROID_ABI STREQUAL "armeabi-v7a")
  set(RNR_TRIPLE armv7-linux-androideabi)
elseif(ANDROID_ABI STREQUAL "x86")
  set(RNR_TRIPLE i686-linux-android)
elseif(ANDROID_ABI STREQUAL "x86_64")
  set(RNR_TRIPLE x86_64-linux-android)
else()
  message(FATAL_ERROR "rnr: unsupported ABI ${ANDROID_ABI}")
endif()
set(RNR_BUNDLE_LIB "${RNR_BUNDLE_TARGET_DIR}/${RNR_TRIPLE}/release/librnr_bundle.a")
if(NOT EXISTS "${RNR_BUNDLE_LIB}")
  # Not fatal at configure time: an IDE sync can configure CMake before the bundle task ran.
  # Every Gradle build runs rnrBuildRustBundle before the CMake tasks; linking without the
  # bundle fails naming this file.
  message(WARNING "rnr: the app's Rust bundle ${RNR_BUNDLE_LIB} is not built yet; the rnrBuildRustBundle Gradle task builds it before compiling")
endif()
add_library(rnr_bundle STATIC IMPORTED)
set_target_properties(rnr_bundle PROPERTIES IMPORTED_LOCATION "${RNR_BUNDLE_LIB}")

# Platform-independent framework C++ (JSI adapter, runtime scope, bindings) is shared with
# iOS in ../cpp; src/main/jni holds only the JNI side.
file(GLOB rnr_sources CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/src/main/jni/*.cpp" "${CMAKE_CURRENT_SOURCE_DIR}/../cpp/*.cpp")
add_library(rnr SHARED ${rnr_sources})
target_include_directories(rnr PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/../cpp")
target_compile_options(rnr PRIVATE -frtti -fexceptions -Wall -Werror)
option(RNR_TEST_HOOKS "Compile the native test hooks (device test harnesses only)" OFF)
if(RNR_TEST_HOOKS)
  target_compile_definitions(rnr PRIVATE RNR_TEST_HOOKS=1)
endif()
# 16 KB page sizes (Android 15+ devices): React Native (0.83.1 to 0.88.0) sets flexible page sizes only
# for com.android.application modules, and this is a library, so librnr.so (which also
# contains the app's Rust bundle) is linked with 16 KB segment alignment here. NDK 27 or
# lower needs both flags (developer.android.com/guide/practices/page-sizes); 4 KB devices
# load such libraries unchanged.
target_link_options(rnr PRIVATE "-Wl,-z,max-page-size=16384" "-Wl,-z,common-page-size=16384")
# Attribution counters (Gradle -Prnr.diagnostics=true; never for measurements).
if(RNR_DIAGNOSTICS)
  target_compile_definitions(rnr PRIVATE RNR_DIAGNOSTICS=1)
endif()
target_link_libraries(rnr
  rnr_bundle
  ReactAndroid::jsi
  ReactAndroid::reactnative
  fbjni::fbjni
  android
  log
  dl
  m)
