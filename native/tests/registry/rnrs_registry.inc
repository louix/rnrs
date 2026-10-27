// Test registry for native/tests/rnrs_registry_test.cpp (the shape `rnrs link` generates).
extern "C" const RnrsModuleV5* rnrs_module_v5_good();
extern "C" const RnrsModuleV5* rnrs_module_v5_other_abi();
extern "C" const RnrsModuleV5* rnrs_module_v5_bad_vtable();
extern "C" const RnrsModuleV5* rnrs_module_v5_duplicate();
extern "C" const RnrsModuleV5* rnrs_module_v5_second();
static const RnrsModuleEntry kRnrsModules[] = {
    {"rnrs_module_v5_good", rnrs_module_v5_good},
    {"rnrs_module_v5_other_abi", rnrs_module_v5_other_abi},
    {"rnrs_module_v5_bad_vtable", rnrs_module_v5_bad_vtable},
    {"rnrs_module_v5_duplicate", rnrs_module_v5_duplicate},
    {"rnrs_module_v5_second", rnrs_module_v5_second},
    {nullptr, nullptr},
};
