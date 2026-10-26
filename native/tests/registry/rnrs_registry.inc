// Test registry for native/tests/rnrs_registry_test.cpp (the shape `rnrs link` generates).
extern "C" const RnrsModuleV1* rnrs_module_v1_good();
extern "C" const RnrsModuleV1* rnrs_module_v1_other_abi();
extern "C" const RnrsModuleV1* rnrs_module_v1_bad_vtable();
extern "C" const RnrsModuleV1* rnrs_module_v1_duplicate();
extern "C" const RnrsModuleV1* rnrs_module_v1_second();
static const RnrsModuleEntry kRnrsModules[] = {
    {"rnrs_module_v1_good", rnrs_module_v1_good},
    {"rnrs_module_v1_other_abi", rnrs_module_v1_other_abi},
    {"rnrs_module_v1_bad_vtable", rnrs_module_v1_bad_vtable},
    {"rnrs_module_v1_duplicate", rnrs_module_v1_duplicate},
    {"rnrs_module_v1_second", rnrs_module_v1_second},
    {nullptr, nullptr},
};
