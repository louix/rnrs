// Execute actual emitted mixed-arity scalar thunks through the host backend ABI.
// Offline with a warm Cargo cache; RNRS_REQUIRE_CARGO=1 makes missing Cargo a failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitGlue, emitInterface } from '../emit-rust.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const cargo = process.env.RNRS_CARGO ?? 'cargo';
const available = spawnSync(cargo, ['--version']).status === 0;

test(
  'emitted mixed arity 3/4 scalar bindings execute with correct masks, slots and result tags',
  {
    skip: !available && process.env.RNRS_REQUIRE_CARGO !== '1' ? 'cargo is not available' : false,
    timeout: 120_000,
  },
  () => {
    assert.ok(available, 'RNRS_REQUIRE_CARGO=1 requires Cargo');
    const method = (name, kinds, result) => ({
      name,
      async: false,
      params: kinds.map((k, i) => ({ name: `a${i}`, type: { k } })),
      returns: { k: result },
    });
    const ir = {
      spec: 'scalar-execution fixture',
      module: 'ProbeModule',
      hash: 'scalar-execution',
      objects: [],
      records: [],
      unions: [],
      methods: [
        method('three', ['number', 'boolean', 'number'], 'number'),
        method('four', ['boolean', 'number', 'boolean', 'number'], 'boolean'),
      ],
    };
    mkdirSync(path.join(root, '.generated'), { recursive: true });
    const work = mkdtempSync(path.join(root, '.generated/scalar-execution-'));
    try {
      mkdirSync(path.join(work, 'src'));
      writeFileSync(
        path.join(work, 'Cargo.toml'),
        `[package]
name = "scalar-execution-probe"
version = "0.0.0"
edition = "2021"
[workspace]
[dependencies]
rnrs-core = { path = ${JSON.stringify(path.join(root, 'rust/rnrs-core'))} }
rnrs-android = { path = ${JSON.stringify(path.join(root, 'rust/rnrs-android'))} }
`,
      );
      writeFileSync(path.join(work, 'src/rnrs_interface.rs'), emitInterface(ir));
      writeFileSync(
        path.join(work, 'src/generated.rs'),
        emitGlue(ir, { crate: 'crate', moduleType: 'Probe' }),
      );
      writeFileSync(
        path.join(work, 'src/lib.rs'),
        `pub mod rnrs_interface;
mod generated;
#[derive(Default)]
pub struct Probe;
impl rnrs_interface::ProbeModule for Probe {
    fn three(&self, a0: f64, a1: bool, a2: f64) -> Result<f64, String> {
        Ok((100.0 * a0 + a2) * if a1 { -1.0 } else { 1.0 })
    }
    fn four(&self, a0: bool, a1: f64, a2: bool, a3: f64) -> Result<bool, String> {
        Ok((a0 && a1 == 2.0) != (a2 && a3 == 7.0))
    }
}
#[cfg(test)]
mod tests {
    use rnrs_android::*;
    use std::{ffi::c_void, mem::MaybeUninit};
    static MODULES: [&rnrs_core::bind::ModuleDef; 1] = [&super::generated::MODULE];
    extern "C" fn noop(_: *mut c_void) {}
    extern "C" fn queued(_: *mut c_void) -> u8 { 0 }
    #[test]
    fn emitted_thunks_via_backend() {
        let defs = super::generated::MODULE.scalars;
        assert_eq!(defs.len(), 2);
        assert_eq!((defs[0].method, defs[0].args, defs[0].result), (0, 25, 1));
        assert_eq!((defs[1].method, defs[1].args, defs[1].result), (1, 102, 2));
        register(&MODULES);
        let mut error = [0u8; 512];
        let adapter = unsafe { rnrs_adapter_new(0, 4, noop, queued, noop, std::ptr::null_mut(), error.as_mut_ptr(), error.len()) };
        assert!(!adapter.is_null());
        let invoke = |index, args: [f64; 4]| {
            let mut binding = MaybeUninit::uninit();
            let mut method = u32::MAX;
            assert!(unsafe { rnrs_adapter_scalar(adapter, index, &mut method, binding.as_mut_ptr()) });
            assert_eq!(method as usize, index);
            let binding = unsafe { binding.assume_init() };
            let mut result = f64::NAN;
            let mut kind = u32::MAX;
            let mut error = [0u8; 512];
            assert_eq!(unsafe { rnrs_scalar_call(adapter, &binding, &args, &mut result, &mut kind, error.as_mut_ptr(), error.len()) }, RNRS_CALL_OK);
            result
        };
        // Distinct numbers expose slot transposition; unused fourth slot is ignored.
        assert_eq!(invoke(0, [2.0, 0.0, 7.0, f64::NAN]), 207.0);
        assert_eq!(invoke(0, [2.0, 1.0, 7.0, f64::NAN]), -207.0);
        assert_eq!(invoke(0, [-3.0, 0.0, 5.0, f64::NAN]), -295.0);
        for a in [false, true] {
            for b in [false, true] {
                assert_eq!(invoke(1, [a as u8 as f64, 2.0, b as u8 as f64, 7.0]), (a != b) as u8 as f64);
            }
        }
        assert_eq!(invoke(1, [1.0, 7.0, 0.0, 2.0]), 0.0);
        unsafe { rnrs_adapter_free(adapter) };
    }
}
`,
      );
      const result = spawnSync(
        cargo,
        ['test', '--offline', '--manifest-path', path.join(work, 'Cargo.toml')],
        {
          cwd: root,
          encoding: 'utf8',
          timeout: 110_000,
          env: { ...process.env, CARGO_TARGET_DIR: path.join(root, 'target') },
        },
      );
      assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /1 passed; 0 failed/);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
);
