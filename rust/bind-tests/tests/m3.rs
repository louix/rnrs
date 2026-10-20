//! M3: discriminated unions through generated glue.
use bind_tests::harness::Harness;
use bind_tests::modules::values;
use bind_tests::V;

const NONE: V = V::Undefined;

fn h() -> Harness {
    Harness::new(&values::MODULE, 8)
}

fn circle(r: f64) -> V {
    V::obj(vec![("kind", V::str("circle")), ("radius", V::Num(r))])
}

#[test]
fn every_variant_round_trips_including_unit_variants() {
    let h = h();
    let mut env = h.env();
    let rect = V::obj(vec![("kind", V::str("rect")), ("width", V::Num(2.0)), ("height", V::Num(3.0))]);
    let empty = V::obj(vec![("kind", V::str("empty"))]);
    for (shape, area) in [(circle(1.0), std::f64::consts::PI), (rect.clone(), 6.0), (empty.clone(), 0.0)] {
        assert_eq!(h.call(&mut env, "area", NONE, vec![shape.clone()]).unwrap().num(), area);
        let back = h.call(&mut env, "echoShape", NONE, vec![shape.clone()]).unwrap();
        assert_eq!(format!("{back:?}"), format!("{shape:?}"));
    }
    let all = h.call(&mut env, "allShapes", NONE, vec![]).unwrap().items();
    let kinds: Vec<_> = all.iter().map(|s| s.get("kind").unwrap().string()).collect();
    assert_eq!(kinds, ["circle", "rect", "empty"]);
    assert_eq!(all[2].keys(), ["kind"], "unit variant: discriminator only");
}

#[test]
fn constant_literal_fields_are_checked_and_restored() {
    let h = h();
    let mut env = h.env();
    let round = V::obj(vec![("kind", V::str("round")), ("category", V::str("curved")), ("r", V::Num(2.0))]);
    let back = h.call(&mut env, "echoTagged", NONE, vec![round]).unwrap();
    assert_eq!(back.keys(), ["kind", "category", "r"]);
    assert_eq!(back.get("category").unwrap().string(), "curved");
    let wrong = V::obj(vec![("kind", V::str("round")), ("category", V::str("angular")), ("r", V::Num(2.0))]);
    assert_eq!(h.call(&mut env, "echoTagged", NONE, vec![wrong]).unwrap_err(), "TypeError: t.category must be \"curved\"");
    let missing = V::obj(vec![("kind", V::str("square")), ("side", V::Num(1.0))]);
    assert_eq!(h.call(&mut env, "echoTagged", NONE, vec![missing]).unwrap_err(), "TypeError: t.category must be \"angular\"");
}

#[test]
fn unknown_missing_and_non_string_tags_are_rejected() {
    let h = h();
    let mut env = h.env();
    let unknown = V::obj(vec![("kind", V::str("triangle"))]);
    assert_eq!(h.call(&mut env, "area", NONE, vec![unknown]).unwrap_err(),
        "TypeError: s.kind: unknown Shape tag \"triangle\"; expected one of \"circle\", \"rect\", \"empty\"");
    assert_eq!(h.call(&mut env, "area", NONE, vec![V::obj(vec![("radius", V::Num(1.0))])]).unwrap_err(),
        "TypeError: s.kind must be one of \"circle\", \"rect\", \"empty\"");
    assert_eq!(h.call(&mut env, "area", NONE, vec![V::obj(vec![("kind", V::Num(1.0))])]).unwrap_err(),
        "TypeError: s.kind must be one of \"circle\", \"rect\", \"empty\"");
    assert_eq!(h.call(&mut env, "area", NONE, vec![V::str("circle")]).unwrap_err(), "TypeError: s must be a Shape object, got a string");
    // A known tag with the wrong fields reports the field path.
    let bad = V::obj(vec![("kind", V::str("circle")), ("radius", V::str("1"))]);
    assert_eq!(h.call(&mut env, "area", NONE, vec![bad]).unwrap_err(), "TypeError: s.radius must be a number, got a string");
}

#[test]
fn nested_unions_records_optional_and_nullable_fields() {
    let h = h();
    let mut env = h.env();
    let mv = V::obj(vec![("type", V::str("move")), ("to", V::obj(vec![("x", V::Num(1.0)), ("y", V::Num(2.0))]))]);
    let back = h.call(&mut env, "echoEvent", NONE, vec![mv]).unwrap();
    assert_eq!(back.get("to").unwrap().get("y").unwrap().num(), 2.0);
    let batch = V::obj(vec![("type", V::str("batch")), ("shapes", V::arr(vec![circle(1.0), V::obj(vec![("kind", V::str("empty"))])]))]);
    let back = h.call(&mut env, "echoEvent", NONE, vec![batch]).unwrap();
    assert_eq!(back.keys(), ["type", "shapes"], "absent optional label omitted");
    assert_eq!(back.get("shapes").unwrap().items()[1].get("kind").unwrap().string(), "empty");
    let bad_batch = V::obj(vec![("type", V::str("batch")), ("shapes", V::arr(vec![V::obj(vec![("kind", V::str("hex"))])]))]);
    assert!(h.call(&mut env, "echoEvent", NONE, vec![bad_batch]).unwrap_err().starts_with("TypeError: e.shapes[0].kind: unknown Shape tag \"hex\""));
    let two = V::obj(vec![("type", V::str("two-words")), ("note", V::Null)]);
    let back = h.call(&mut env, "echoEvent", NONE, vec![two]).unwrap();
    assert!(back.get("note").unwrap().is_null());
    assert!(h.call(&mut env, "maybeShape", NONE, vec![V::Null]).unwrap().is_null());
    assert_eq!(h.call(&mut env, "maybeShape", NONE, vec![circle(2.0)]).unwrap().get("radius").unwrap().num(), 2.0);
}

#[test]
fn async_union_results() {
    let h = h();
    let mut env = h.env();
    h.call(&mut env, "scaleLater", NONE, vec![circle(2.0), V::Num(3.0)]).unwrap();
    let out = h.settle(&mut env, 1);
    assert_eq!(out[0].2.get("radius").unwrap().num(), 6.0);
    assert_eq!(out[0].2.get("kind").unwrap().string(), "circle");
}
