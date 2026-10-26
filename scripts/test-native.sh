#!/usr/bin/env bash
# Host tests for framework C++ that has no JSI/JNI dependency (inside `nix develop`).
set -euo pipefail
cd "$(dirname "$0")/.."
out=.generated/native-tests
mkdir -p "$out"
cpp=packages/runtime/cpp
clang++ -std=c++20 -g -O1 -fsanitize=thread -Wall -Wextra -I "$cpp" \
  native/tests/rnrs_scope_test.cpp "$cpp/RnrsScope.cpp" "$cpp/RnrsPlatform.cpp" -o "$out/rnrs_scope_test"
"$out/rnrs_scope_test"
# The JSI string encoder (shared C++, no JSI dependency): ASan + UBSan.
clang++ -std=c++20 -g -O1 -fsanitize=address,undefined -fno-sanitize-recover=all -Wall -Wextra -I "$cpp" \
  native/tests/utf8_encoder_test.cpp -o "$out/utf8_encoder_test"
"$out/utf8_encoder_test"
# Runtime identity under address reuse (pure C++ part of the foreign-runtime guard): TSan.
clang++ -std=c++20 -g -O1 -fsanitize=thread -Wall -Wextra -I "$cpp" \
  native/tests/rnrs_runtime_identity_test.cpp -o "$out/rnrs_runtime_identity_test"
"$out/rnrs_runtime_identity_test"
# Drain-post fate tracking (RnrsDelivery.h): copies, drops, runs, throws, drops under a held
# mutex and concurrent reads, with a fake invoker: TSan.
clang++ -std=c++20 -g -O1 -fsanitize=thread -Wall -Wextra -I "$cpp" \
  native/tests/rnrs_delivery_test.cpp -o "$out/rnrs_delivery_test"
"$out/rnrs_delivery_test"
# Module registry (RnrsRegistry.cpp) with fake module tables (native/tests/registry/): refusal
# of other ABIs and sizes before use, duplicates, init order, app data dir broadcast. ASan + UBSan.
clang++ -std=c++20 -g -O1 -fsanitize=address,undefined -fno-sanitize-recover=all -Wall -Wextra -I "$cpp" \
  -I native/tests/registry native/tests/rnrs_registry_test.cpp "$cpp/RnrsRegistry.cpp" "$cpp/RnrsPlatform.cpp" \
  -o "$out/rnrs_registry_test"
"$out/rnrs_registry_test"
