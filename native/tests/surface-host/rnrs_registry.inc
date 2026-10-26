// Test registry for native/tests/rnrs_surface_host_test.cpp (the shape `rnrs link` generates):
// binary A (one module), binary B (two modules sharing one surface table), a headless module, a
// module whose surface table has another ABI and one whose table refuses to bind.
extern "C" const RnrsModuleV2* rnrs_module_v2_a();
extern "C" const RnrsModuleV2* rnrs_module_v2_headless();
extern "C" const RnrsModuleV2* rnrs_module_v2_b1();
extern "C" const RnrsModuleV2* rnrs_module_v2_b2();
extern "C" const RnrsModuleV2* rnrs_module_v2_other_surface_abi();
extern "C" const RnrsModuleV2* rnrs_module_v2_unbindable();
static const RnrsModuleEntry kRnrsModules[] = {
    {"rnrs_module_v2_a", rnrs_module_v2_a},
    {"rnrs_module_v2_headless", rnrs_module_v2_headless},
    {"rnrs_module_v2_other_surface_abi", rnrs_module_v2_other_surface_abi},
    {"rnrs_module_v2_b1", rnrs_module_v2_b1},
    {"rnrs_module_v2_unbindable", rnrs_module_v2_unbindable},
    {"rnrs_module_v2_b2", rnrs_module_v2_b2},
    {nullptr, nullptr},
};
