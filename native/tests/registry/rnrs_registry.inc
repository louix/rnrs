// Test registry for native/tests/rnrs_registry_test.cpp (the shape `rnrs link` generates).
extern "C" const RnrsModuleV2* rnrs_module_v2_good();
extern "C" const RnrsModuleV2* rnrs_module_v2_other_abi();
extern "C" const RnrsModuleV2* rnrs_module_v2_bad_vtable();
extern "C" const RnrsModuleV2* rnrs_module_v2_duplicate();
extern "C" const RnrsModuleV2* rnrs_module_v2_second();
static const RnrsModuleEntry kRnrsModules[] = {
    {"rnrs_module_v2_good", rnrs_module_v2_good},
    {"rnrs_module_v2_other_abi", rnrs_module_v2_other_abi},
    {"rnrs_module_v2_bad_vtable", rnrs_module_v2_bad_vtable},
    {"rnrs_module_v2_duplicate", rnrs_module_v2_duplicate},
    {"rnrs_module_v2_second", rnrs_module_v2_second},
    {nullptr, nullptr},
};
