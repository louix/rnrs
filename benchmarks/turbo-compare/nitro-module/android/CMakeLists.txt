project(NitroCmp)
cmake_minimum_required(VERSION 3.9.0)

set(PACKAGE_NAME NitroCmp)
set(CMAKE_CXX_STANDARD 20)

add_library(${PACKAGE_NAME} SHARED src/main/cpp/cpp-adapter.cpp)

# Nitrogen 0.37.1 generated autolinking (sources, includes, Nitro/RN/fbjni prefabs).
include(${CMAKE_SOURCE_DIR}/../nitrogen/generated/android/NitroCmp+autolinking.cmake)

include_directories("src/main/cpp" "../cpp")

find_library(LOG_LIB log)
target_link_libraries(${PACKAGE_NAME} ${LOG_LIB} android)
