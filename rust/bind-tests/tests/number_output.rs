//! `number[]` output: generated glue builds every numeric array with one
//! `Env::new_number_array` call (the default and the mock build it element by element), at the
//! top level and inside the composite writers the generator nests it in.
use bind_tests::harness::Harness;
use bind_tests::modules::values;
use bind_tests::{MockEnv, V};
use rnrs_core::bind::{array_into_js_with, nullable_into_js_with, number_array_into_js, BindError, Env};

const NONE: V = V::Undefined;
const SPECIAL: [f64; 9] = [1.5, -0.0, 0.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 5e-324, -f64::MAX, 9007199254740994.0];

fn same(a: f64, b: f64) -> bool {
    a.to_bits() == b.to_bits() || (a.is_nan() && b.is_nan())
}

fn numbers(v: &V) -> Vec<f64> {
    v.items().iter().map(V::num).collect()
}

fn assert_numbers(v: &V, expected: &[f64]) {
    let got = numbers(v);
    assert_eq!(got.len(), expected.len());
    for (i, (a, b)) in got.iter().zip(expected).enumerate() {
        assert!(same(*a, *b), "index {i}: {a} vs {b}");
    }
}

#[test]
fn generated_results_take_the_bulk_path() {
    let h = Harness::new(&values::MODULE, 8);
    let mut env = h.env();
    let xs = V::arr(SPECIAL.iter().map(|&x| V::Num(x)).collect());
    let back = h.call(&mut env, "echoNumbers", NONE, vec![xs]).unwrap();
    assert_numbers(&back, &SPECIAL);
    assert_eq!(env.number_arrays, [SPECIAL.len()]);
    let empty = h.call(&mut env, "echoNumbers", NONE, vec![V::arr(vec![])]).unwrap();
    assert!(empty.items().is_empty());
    let big: Vec<f64> = (0..100_000).map(|i| i as f64 * 0.25).collect();
    let back = h.call(&mut env, "echoNumbers", NONE, vec![V::arr(big.iter().map(|&x| V::Num(x)).collect())]).unwrap();
    assert_numbers(&back, &big);
    // byteLengths(ArrayBuffer[]): number[]
    let lengths = h.call(&mut env, "byteLengths", NONE, vec![V::arr(vec![V::buf(&[]), V::buf(&[1, 2])])]).unwrap();
    assert_numbers(&lengths, &[0.0, 2.0]);
    assert_eq!(env.number_arrays, [SPECIAL.len(), 0, big.len(), 2]);
    // Other arrays keep the element-wise writer.
    h.call(&mut env, "echoStrings", NONE, vec![V::arr(vec![V::str("x")])]).unwrap();
    h.call(&mut env, "points", NONE, vec![V::Num(2.0)]).unwrap();
    assert_eq!(env.number_arrays.len(), 4);
}

// The expressions emitted for number[][], (number[] | null) and a record field
// (tools/rnrs-gen/test/generate.test.mjs pins the same text).
#[test]
fn nested_writers_build_each_numeric_array_in_one_call() {
    let mut env = MockEnv::new(1);
    let rows = vec![vec![1.0, -0.0], vec![], vec![f64::NAN]];
    let v = array_into_js_with(rows.clone(), &mut env, &mut |value, env| number_array_into_js(value, env)).unwrap();
    let v = env.take(v);
    for (row, expected) in v.items().iter().zip(&rows) {
        assert_numbers(row, expected);
    }
    assert_eq!(env.number_arrays, [2, 0, 1]);

    let some = nullable_into_js_with(Some(vec![3.0]), &mut env, &mut |value, env| number_array_into_js(value, env)).unwrap();
    assert_numbers(&env.take(some), &[3.0]);
    let none = nullable_into_js_with(None, &mut env, &mut |value, env| number_array_into_js(value, env)).unwrap();
    assert!(env.take(none).is_null());
    assert_eq!(env.number_arrays, [2, 0, 1, 1]);

    let object = env.object();
    let value = number_array_into_js(vec![4.0, 5.0], &mut env).unwrap();
    env.set_property(object, "xs", value).unwrap();
    assert_numbers(&env.take(object).get("xs").unwrap(), &[4.0, 5.0]);
    assert_eq!(env.number_arrays.len(), 5);
}

/// An Env whose element definition fails at `fail_at` (a throwing define): the default path
/// stops there and reports the exception.
struct Failing {
    inner: MockEnv,
    fail_at: u32,
}

impl Env for Failing {
    fn kind(&mut self, v: rnrs_core::bind::Val) -> rnrs_core::bind::Kind {
        self.inner.kind(v)
    }
    fn to_number(&mut self, v: rnrs_core::bind::Val) -> f64 {
        self.inner.to_number(v)
    }
    fn to_bool(&mut self, v: rnrs_core::bind::Val) -> bool {
        self.inner.to_bool(v)
    }
    fn to_string(&mut self, v: rnrs_core::bind::Val) -> String {
        self.inner.to_string(v)
    }
    fn get_property(&mut self, o: rnrs_core::bind::Val, k: &str) -> Result<rnrs_core::bind::Val, BindError> {
        self.inner.get_property(o, k)
    }
    fn array_length(&mut self, a: rnrs_core::bind::Val) -> Result<u32, BindError> {
        self.inner.array_length(a)
    }
    fn get_index(&mut self, a: rnrs_core::bind::Val, i: u32) -> Result<rnrs_core::bind::Val, BindError> {
        self.inner.get_index(a, i)
    }
    fn own_entries(&mut self, v: rnrs_core::bind::Val) -> Result<Option<rnrs_core::bind::Val>, BindError> {
        self.inner.own_entries(v)
    }
    fn undefined(&mut self) -> rnrs_core::bind::Val {
        self.inner.undefined()
    }
    fn null(&mut self) -> rnrs_core::bind::Val {
        self.inner.null()
    }
    fn number(&mut self, x: f64) -> rnrs_core::bind::Val {
        self.inner.number(x)
    }
    fn boolean(&mut self, b: bool) -> rnrs_core::bind::Val {
        self.inner.boolean(b)
    }
    fn string(&mut self, s: &str) -> rnrs_core::bind::Val {
        self.inner.string(s)
    }
    fn object(&mut self) -> rnrs_core::bind::Val {
        self.inner.object()
    }
    fn set_property(&mut self, o: rnrs_core::bind::Val, k: &str, v: rnrs_core::bind::Val) -> Result<(), BindError> {
        self.inner.set_property(o, k, v)
    }
    fn array(&mut self, n: u32) -> rnrs_core::bind::Val {
        self.inner.array(n)
    }
    fn set_index(&mut self, a: rnrs_core::bind::Val, i: u32, v: rnrs_core::bind::Val) -> Result<(), BindError> {
        if i == self.fail_at {
            self.inner.thrown = Some("define threw".into());
            return Err(BindError::Thrown);
        }
        self.inner.set_index(a, i, v)
    }
    fn to_bytes(&mut self, v: rnrs_core::bind::Val, out: &mut Vec<u8>) -> Result<(), rnrs_core::bind::BytesError> {
        self.inner.to_bytes(v, out)
    }
    fn new_bytes(&mut self, data: Vec<u8>) -> Result<rnrs_core::bind::Val, BindError> {
        self.inner.new_bytes(data)
    }
    fn wrap_native(&mut self, o: rnrs_core::bind::NativeBox) -> Result<rnrs_core::bind::Val, BindError> {
        self.inner.wrap_native(o)
    }
    fn unwrap_native(&mut self, v: rnrs_core::bind::Val) -> Result<&rnrs_core::bind::NativeBox, rnrs_core::bind::UnwrapError> {
        self.inner.unwrap_native(v)
    }
}

#[test]
fn the_default_matches_the_element_writer_and_propagates_exceptions() {
    // `Failing` keeps the trait default (it does not override new_number_array).
    let mut env = Failing { inner: MockEnv::new(1), fail_at: u32::MAX };
    let v = number_array_into_js(SPECIAL.to_vec(), &mut env).unwrap();
    assert_numbers(&env.inner.take(v), &SPECIAL);
    let empty = number_array_into_js(vec![], &mut env).unwrap();
    assert!(env.inner.take(empty).items().is_empty());
    assert!(env.inner.number_arrays.is_empty(), "the default does not go through the mock's override");

    env.fail_at = 1;
    assert_eq!(number_array_into_js(vec![1.0, 2.0, 3.0], &mut env), Err(BindError::Thrown));
    assert_eq!(env.inner.thrown.as_deref(), Some("define threw"));
    // Inside a composite writer the error stops the outer conversion too.
    let rows = vec![vec![1.0], vec![1.0, 2.0], vec![3.0]];
    assert_eq!(array_into_js_with(rows, &mut env, &mut |value, env| number_array_into_js(value, env)), Err(BindError::Thrown));
}
