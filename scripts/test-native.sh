#!/usr/bin/env bash
# Host tests for framework C++ that has no JSI/JNI dependency (inside `nix develop`).
set -euo pipefail
cd "$(dirname "$0")/.."
out=.generated/native-tests
mkdir -p "$out"
cpp=packages/runtime/cpp
clang++ -std=c++20 -g -O1 -fsanitize=thread -Wall -Wextra -I "$cpp" \
  native/tests/rnr_scope_test.cpp "$cpp/RnrScope.cpp" "$cpp/RnrPlatform.cpp" -o "$out/rnr_scope_test"
"$out/rnr_scope_test"
# The JSI string encoder (shared C++, no JSI dependency): ASan + UBSan.
clang++ -std=c++20 -g -O1 -fsanitize=address,undefined -fno-sanitize-recover=all -Wall -Wextra -I "$cpp" \
  native/tests/utf8_encoder_test.cpp -o "$out/utf8_encoder_test"
"$out/utf8_encoder_test"
# Runtime identity under address reuse (pure C++ part of the foreign-runtime guard): TSan.
clang++ -std=c++20 -g -O1 -fsanitize=thread -Wall -Wextra -I "$cpp" \
  native/tests/rnr_runtime_identity_test.cpp -o "$out/rnr_runtime_identity_test"
"$out/rnr_runtime_identity_test"
# Drain-post fate tracking (RnrDelivery.h): copies, drops, runs, throws, drops under a held
# mutex and concurrent reads, with a fake invoker: TSan.
clang++ -std=c++20 -g -O1 -fsanitize=thread -Wall -Wextra -I "$cpp" \
  native/tests/rnr_delivery_test.cpp -o "$out/rnr_delivery_test"
"$out/rnr_delivery_test"
