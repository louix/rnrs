#pragma once
// The app's linked Rust modules: one validated table per module (RnrsAbi.h), from the
// registry that `rnrs link` generates for the app (rnrs_registry.inc). No JSI here.
#include <string>
#include "RnrsAbi.h"

namespace rnrs {

// The table of module `name` whose glue was generated from the spec with IR `hash` (the JS
// wrapper's), or null with an actionable message in `error`. Validates every linked table
// once (ABI and struct sizes, before any other call into its binary), binds each distinct
// surface table to its owner number, then runs each binary's init, in that order.
const RnrsModuleV3* findModule(const std::string& name, const std::string& hash, std::string& error);

// The surface table bound to `owner` (1, 2, ...; RnrsSurfaceHost.h), or null past the last.
const RnrsSurfaceV1* surfaceOwner(uint32_t owner);

// Gives every linked module the application's private data directory (called by the
// platform module before any module exists). False, after logging which module refused,
// if any of them did not accept it.
bool setAppDataDir(const std::string& path);

}  // namespace rnrs
