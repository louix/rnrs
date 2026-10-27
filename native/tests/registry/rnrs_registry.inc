// Test registry for native/tests/rnrs_registry_test.cpp (the shape `rnrs link` generates).
extern "C" const RnrsModuleV3* rnrs_module_v3_good();
extern "C" const RnrsModuleV3* rnrs_module_v3_other_abi();
extern "C" const RnrsModuleV3* rnrs_module_v3_bad_vtable();
extern "C" const RnrsModuleV3* rnrs_module_v3_duplicate();
extern "C" const RnrsModuleV3* rnrs_module_v3_second();
static const RnrsModuleEntry kRnrsModules[] = {
    {"rnrs_module_v3_good", rnrs_module_v3_good},
    {"rnrs_module_v3_other_abi", rnrs_module_v3_other_abi},
    {"rnrs_module_v3_bad_vtable", rnrs_module_v3_bad_vtable},
    {"rnrs_module_v3_duplicate", rnrs_module_v3_duplicate},
    {"rnrs_module_v3_second", rnrs_module_v3_second},
    {nullptr, nullptr},
};
