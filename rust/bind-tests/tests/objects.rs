//! Native-object composition through generated glue: objects creating and taking other native
//! types, handles inside records, unions, arrays and optional/nullable values, wrapper objects
//! carrying a handle, ownership across async calls, and failures that must not keep clones.
use bind_tests::harness::{Harness, Settled};
use bind_tests::modules::values;
use std::cell::Cell;
use std::rc::Rc;

use bind_tests::{dispose, Obj, Prop, V};
use rnrs_core::bind::NativeBox;
use rnrs_core::Native;

const NONE: V = V::Undefined;

fn h() -> Harness {
    Harness::new(&values::MODULE, 8)
}

/// A new owner of the object behind `wrapper`, taken directly (no adapter call).
fn object<T: 'static>(wrapper: &V) -> Native<T> {
    let V::Native(slot) = wrapper else { panic!("not a wrapper: {wrapper:?}") };
    let native = slot.native.borrow();
    let boxed: &NativeBox = native.as_ref().expect("live");
    boxed.value.downcast_ref::<Native<T>>().expect("Rust type").clone()
}

fn same<T: 'static>(a: &V, b: &V) -> bool {
    Native::ptr_eq(&object::<T>(a), &object::<T>(b))
}

/// What a generated JS wrapper class looks like to the glue: an object with `handle`.
fn wrapper(handle: &V) -> V {
    V::obj(vec![("handle", handle.clone())])
}

fn call(h: &Harness, env: &mut bind_tests::MockEnv, name: &str, this: &V, args: Vec<V>) -> V {
    h.call(env, name, this.clone(), args).unwrap_or_else(|e| panic!("{name}: {e}"))
}

#[test]
fn objects_create_and_take_other_native_types() {
    let h = h();
    let mut env = h.env();
    let db = call(&h, &mut env, "openDatabase", &NONE, vec![V::str("main")]);
    let statement = call(&h, &mut env, "Database.prepare", &db, vec![V::str("select 1")]);
    assert_eq!(call(&h, &mut env, "Statement.sql", &statement, vec![]).string(), "select 1");
    // A cycle in the object graph: the statement hands out its database.
    let again = call(&h, &mut env, "Statement.database", &statement, vec![]);
    assert_eq!(call(&h, &mut env, "Database.name", &again, vec![]).string(), "main");

    let paint = call(&h, &mut env, "paint", &NONE, vec![]);
    let shader = call(&h, &mut env, "shader", &NONE, vec![V::str("linear")]);
    assert!(call(&h, &mut env, "Paint.shader", &paint, vec![]).is_null());
    call(&h, &mut env, "Paint.setShader", &paint, vec![shader.clone()]);
    let held = call(&h, &mut env, "Paint.shader", &paint, vec![]);
    assert!(same::<::values::NamedShader>(&held, &shader), "the same object, not a copy");
    assert_eq!(Native::owners(&object::<::values::NamedShader>(&shader)) - 1, 3, "two wrappers and the paint");
    call(&h, &mut env, "Paint.setShader", &paint, vec![V::Null]);
    assert!(call(&h, &mut env, "Paint.shader", &paint, vec![]).is_null());
}

#[test]
fn handles_inside_records_unions_arrays_and_optional_values() {
    let h = h();
    let mut env = h.env();
    let db = call(&h, &mut env, "openDatabase", &NONE, vec![V::str("main")]);
    let shader = call(&h, &mut env, "shader", &NONE, vec![V::str("s")]);

    // Output: a record holding handles; an absent optional handle is omitted.
    let prepared = call(&h, &mut env, "Database.prepared", &db, vec![V::str("q"), shader.clone()]);
    assert_eq!(call(&h, &mut env, "Statement.sql", &prepared.get("statement").unwrap(), vec![]).string(), "q");
    assert!(same::<::values::NamedShader>(&prepared.get("shader").unwrap(), &shader));
    let bare = call(&h, &mut env, "Database.prepared", &db, vec![V::str("r")]);
    assert_eq!(bare.keys(), ["statement", "sql", "others"]);

    // Input: handles and wrapper objects, in fields, optional fields and arrays.
    let a = call(&h, &mut env, "Database.prepare", &db, vec![V::str("a")]);
    let b = call(&h, &mut env, "Database.prepare", &db, vec![V::str("b")]);
    let record = V::obj(vec![
        ("statement", wrapper(&prepared.get("statement").unwrap())),
        ("sql", V::str("q")),
        ("shader", wrapper(&shader)),
        ("others", V::arr(vec![a.clone(), wrapper(&b)])),
    ]);
    assert_eq!(call(&h, &mut env, "Database.describePrepared", &db, vec![record.clone()]).string(), "q|s|a,b");
    let echoed = call(&h, &mut env, "echoPrepared", &NONE, vec![record.clone()]);
    assert!(same::<::values::Statement>(&echoed.get("others").unwrap().items()[1], &b), "identity survives a round trip");
    assert!(call(&h, &mut env, "maybePrepared", &NONE, vec![V::Null]).is_null());
    let maybe = call(&h, &mut env, "maybePrepared", &NONE, vec![record]);
    assert!(same::<::values::Statement>(&maybe.get("others").unwrap().items()[0], &a));

    // Unions: handles in variant fields, arrays and nullable fields, both directions.
    let slots = call(&h, &mut env, "statementSlots", &NONE, vec![db.clone()]).items();
    assert_eq!(slots.len(), 3);
    assert_eq!(slots[0].get("kind").unwrap().string(), "one");
    let many = &slots[1];
    assert!(many.get("first").unwrap().is_null());
    let statements = many.get("statements").unwrap().items();
    assert!(same::<::values::Statement>(&statements[0], &slots[0].get("statement").unwrap()));
    assert_eq!(call(&h, &mut env, "Statement.sql", &statements[1], vec![]).string(), "b");
    let picked = call(&h, &mut env, "Database.pick", &db, vec![slots[0].clone()]);
    assert!(same::<::values::Statement>(&picked, &statements[0]));
    let first = V::obj(vec![("kind", V::str("many")), ("statements", V::arr(vec![])), ("first", wrapper(&a))]);
    assert!(same::<::values::Statement>(&call(&h, &mut env, "Database.pick", &db, vec![first]), &a));
    assert!(call(&h, &mut env, "Database.pick", &db, vec![slots[2].clone()]).is_null());
    assert!(call(&h, &mut env, "Database.pick", &db, vec![V::Null]).is_null());
}

#[test]
fn nested_handles_are_validated_like_arguments() {
    let h = h();
    let mut env = h.env();
    let db = call(&h, &mut env, "openDatabase", &NONE, vec![V::str("main")]);
    let shader = call(&h, &mut env, "shader", &NONE, vec![V::str("s")]);
    let statement = call(&h, &mut env, "Database.prepare", &db, vec![V::str("q")]);
    let record = |statement: V| V::obj(vec![("statement", statement), ("sql", V::str("q")), ("others", V::arr(vec![]))]);
    let describe = |env: &mut bind_tests::MockEnv, p: V| h.call(env, "Database.describePrepared", db.clone(), vec![p]).unwrap_err();

    assert_eq!(describe(&mut env, record(shader.clone())), "TypeError: p.statement must be a Statement");
    assert_eq!(describe(&mut env, record(wrapper(&shader))), "TypeError: p.statement must be a Statement");
    assert_eq!(describe(&mut env, record(V::Num(1.0))), "TypeError: p.statement must be a Statement, got a number");
    assert_eq!(describe(&mut env, record(V::obj(vec![]))), "TypeError: p.statement must be a Statement");
    // One level only: a wrapper's handle must itself be a handle.
    assert_eq!(describe(&mut env, record(wrapper(&wrapper(&statement)))), "TypeError: p.statement must be a Statement");
    assert_eq!(describe(&mut env, record(V::Undefined)), "TypeError: p.statement must be a Statement, got undefined");
    let slot = V::obj(vec![("kind", V::str("one")), ("statement", V::arr(vec![statement.clone()]))]);
    assert_eq!(h.call(&mut env, "Database.pick", db.clone(), vec![slot]).unwrap_err(), "TypeError: slot.statement must be a Statement, got an array");

    // A handle of another adapter generation (another runtime) or a disposed one.
    let other = h_other_statement();
    assert_eq!(describe(&mut env, record(other)), "Error: Statement belongs to a closed runtime adapter");
    let gone = call(&h, &mut env, "Database.prepare", &db, vec![V::str("gone")]);
    let wrapped = wrapper(&gone);
    dispose(&gone);
    assert_eq!(describe(&mut env, record(wrapped)), "Error: Statement is disposed");
    // The receiver too may be a wrapper object.
    assert_eq!(call(&h, &mut env, "Statement.sql", &wrapper(&statement), vec![]).string(), "q");
}

/// A Statement handle created by a different adapter generation.
fn h_other_statement() -> V {
    let other = h();
    let mut env = other.env();
    let db = call(&other, &mut env, "openDatabase", &NONE, vec![V::str("other")]);
    call(&other, &mut env, "Database.prepare", &db, vec![V::str("x")])
}

#[test]
fn a_failed_conversion_keeps_no_clone_of_handles_already_read() {
    let h = h();
    let mut env = h.env();
    let db = call(&h, &mut env, "openDatabase", &NONE, vec![V::str("main")]);
    let statement = call(&h, &mut env, "Database.prepare", &db, vec![V::str("q")]);
    let shader = call(&h, &mut env, "shader", &NONE, vec![V::str("s")]);
    let (s, sh) = (object::<::values::Statement>(&statement), object::<::values::NamedShader>(&shader));
    let before = (Native::owners(&s), Native::owners(&sh));
    let p = V::obj(vec![
        ("statement", statement.clone()),
        ("sql", V::str("q")),
        ("shader", shader.clone()),
        ("others", V::arr(vec![statement.clone(), V::str("not a statement")])),
    ]);
    assert_eq!(h.call(&mut env, "echoPrepared", NONE, vec![p.clone()]).unwrap_err(), "TypeError: p.others[1] must be a Statement, got a string");
    assert_eq!((Native::owners(&s), Native::owners(&sh)), before, "partial conversions released");
    // A successful sync call keeps nothing either once its result's wrappers are gone.
    let fine = V::obj(vec![("statement", statement.clone()), ("sql", V::str("q")), ("others", V::arr(vec![]))]);
    assert_eq!(call(&h, &mut env, "Database.describePrepared", &db, vec![fine]).string(), "q|<none>|");
    assert_eq!((Native::owners(&s), Native::owners(&sh)), before);
}

/// A wrapper whose `handle` is a getter: runs `f` on each read, counted in `reads`.
fn getter_wrapper(reads: &Rc<Cell<u32>>, f: impl Fn() -> Result<V, String> + 'static) -> V {
    let reads = reads.clone();
    let object = Obj::default();
    object.props.borrow_mut().push(("handle".into(), Prop::Getter(Rc::new(move |_| {
        reads.set(reads.get() + 1);
        f()
    }))));
    V::Obj(Rc::new(object))
}

#[test]
fn a_throwing_handle_getter_propagates_and_nothing_runs_or_stays_owned() {
    let h = h();
    let mut env = h.env();
    let db = call(&h, &mut env, "openDatabase", &NONE, vec![V::str("main")]);
    let statement = call(&h, &mut env, "Database.prepare", &db, vec![V::str("q")]);
    let s = object::<::values::Statement>(&statement);
    let before = Native::owners(&s);
    let reads = Rc::new(Cell::new(0));
    let p = V::obj(vec![
        ("statement", statement.clone()),
        ("sql", V::str("q")),
        ("shader", getter_wrapper(&reads, || Err("boom from handle".into()))),
        ("others", V::arr(vec![])),
    ]);
    assert_eq!(h.call(&mut env, "Database.describePrepared", db.clone(), vec![p]).unwrap_err(), "thrown: boom from handle", "the getter's own exception");
    assert_eq!(reads.get(), 1);
    assert_eq!(Native::owners(&s), before, "the statement read before it was released");

    // The method does not run: the paint keeps its shader.
    let paint = call(&h, &mut env, "paint", &NONE, vec![]);
    let old = call(&h, &mut env, "shader", &NONE, vec![V::str("old")]);
    call(&h, &mut env, "Paint.setShader", &paint, vec![old.clone()]);
    let throwing = getter_wrapper(&reads, || Err("boom again".into()));
    assert_eq!(h.call(&mut env, "Paint.setShader", paint.clone(), vec![throwing]).unwrap_err(), "thrown: boom again");
    assert!(same::<::values::NamedShader>(&call(&h, &mut env, "Paint.shader", &paint, vec![]), &old));

    // A getter returning a handle is read exactly once.
    let new = call(&h, &mut env, "shader", &NONE, vec![V::str("new")]);
    let from_getter = new.clone();
    call(&h, &mut env, "Paint.setShader", &paint, vec![getter_wrapper(&reads, move || Ok(from_getter.clone()))]);
    assert_eq!(reads.get(), 3);
    assert!(same::<::values::NamedShader>(&call(&h, &mut env, "Paint.shader", &paint, vec![]), &new));
}

#[test]
fn async_calls_own_their_handles_until_the_task_exits() {
    let h = h();
    let mut env = h.env();
    let paint = call(&h, &mut env, "paint", &NONE, vec![]);
    let shader = call(&h, &mut env, "shader", &NONE, vec![V::str("held")]);
    let observed = object::<::values::NamedShader>(&shader);
    call(&h, &mut env, "Paint.shaderNameLater", &paint, vec![wrapper(&shader), V::Num(50.0)]);
    dispose(&shader);
    assert_eq!(Native::owners(&observed), 2, "the task still owns the shader after JS disposed its wrapper");
    let settled = h.settle(&mut env, 1);
    assert_eq!(settled[0].1, Settled::Ok(String::new()));
    assert_eq!(settled[0].2.string(), "held");
    assert_eq!(Native::owners(&observed), 1, "released when the task exited");

    // Async results holding handles: arrays and records, converted at settlement.
    let db = call(&h, &mut env, "openDatabase", &NONE, vec![V::str("main")]);
    call(&h, &mut env, "Database.prepareAll", &db, vec![V::arr(vec![V::str("a"), V::str("b")])]);
    let all = h.settle(&mut env, 1).remove(0).2.items();
    assert_eq!(call(&h, &mut env, "Statement.sql", &all[1], vec![]).string(), "b");
    call(&h, &mut env, "preparedLater", &NONE, vec![db.clone(), V::str("later"), V::Num(1.0)]);
    let prepared = h.settle(&mut env, 1).remove(0).2;
    assert!(same::<::values::Statement>(&prepared.get("statement").unwrap(), &prepared.get("others").unwrap().items()[0]));
}

#[test]
fn a_cancelled_call_releases_its_handles_when_the_task_exits() {
    let h = h();
    let mut env = h.env();
    let db = call(&h, &mut env, "openDatabase", &NONE, vec![V::str("main")]);
    let observed = object::<::values::Database>(&db);
    let before = Native::owners(&observed);
    let id = call(&h, &mut env, "preparedLater", &NONE, vec![db.clone(), V::str("late"), V::Num(30.0)]).num();
    dispose(&db);
    assert_eq!(Native::owners(&observed), before, "the task's clone replaced the disposed wrapper's");
    assert!(h.adapter.cancel(id as u64));
    let settled = h.settle(&mut env, 1);
    assert_eq!(settled[0].1, Settled::Cancelled);
    // Whether or not the implementation observes cancellation, its task exits and drops the
    // arguments and any discarded result.
    let start = std::time::Instant::now();
    while Native::owners(&observed) != 1 {
        assert!(start.elapsed() < std::time::Duration::from_secs(5), "task kept the database");
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
}

#[test]
fn record_values_hold_handles_directly_and_inside_records() {
    let h = h();
    let mut env = h.env();
    let db = call(&h, &mut env, "openDatabase", &NONE, vec![V::str("main")]);
    let (a, b) = (call(&h, &mut env, "Database.prepare", &db, vec![V::str("a")]), call(&h, &mut env, "Database.prepare", &db, vec![V::str("b")]));

    // Direct: handles and wrapper objects in, handles out, identity kept.
    let out = call(&h, &mut env, "echoStatementsByName", &NONE, vec![V::obj(vec![("x", a.clone()), ("y", wrapper(&b))])]);
    assert_eq!(out.keys(), ["x", "y"]);
    assert!(same::<::values::Statement>(&out.get("x").unwrap(), &a));
    assert!(same::<::values::Statement>(&out.get("y").unwrap(), &b));

    // Inside records, with null values.
    let prepared = V::obj(vec![("statement", wrapper(&a)), ("sql", V::str("a")), ("others", V::arr(vec![b.clone()]))]);
    let out = call(&h, &mut env, "echoPreparedByName", &NONE, vec![V::obj(vec![("p", prepared), ("n", V::Null)])]);
    let p = out.get("p").unwrap();
    assert!(same::<::values::Statement>(&p.get("statement").unwrap(), &a));
    assert!(same::<::values::Statement>(&p.get("others").unwrap().items()[0], &b));
    assert!(out.get("n").unwrap().is_null());

    // Validation at the value's path; a failure releases the handles already converted.
    let s = object::<::values::Statement>(&a);
    let before = Native::owners(&s);
    let shader = call(&h, &mut env, "shader", &NONE, vec![V::str("s")]);
    let wrong = V::obj(vec![("a", a.clone()), ("b", shader)]);
    assert_eq!(h.call(&mut env, "echoStatementsByName", NONE, vec![wrong]).unwrap_err(), "TypeError: m.b must be a Statement");
    let nested = V::obj(vec![("p", V::obj(vec![("statement", a.clone()), ("sql", V::str("a")), ("others", V::arr(vec![V::Num(1.0)]))]))]);
    assert_eq!(h.call(&mut env, "echoPreparedByName", NONE, vec![nested]).unwrap_err(), "TypeError: m.p.others[0] must be a Statement, got a number");
    assert_eq!(Native::owners(&s), before, "partial conversions released");
}

#[test]
fn async_record_results_hold_handles_and_arguments_outlive_disposal() {
    let h = h();
    let mut env = h.env();
    let db = call(&h, &mut env, "openDatabase", &NONE, vec![V::str("main")]);
    let observed = object::<::values::Database>(&db);
    call(&h, &mut env, "statementsByNameLater", &NONE, vec![wrapper(&db), V::arr(vec![V::str("x"), V::str("y")]), V::Num(20.0)]);
    dispose(&db);
    assert_eq!(Native::owners(&observed), 2, "the task owns the database");
    let out = h.settle(&mut env, 1).remove(0).2;
    assert_eq!(out.keys(), ["x", "y"]);
    assert_eq!(call(&h, &mut env, "Statement.sql", &out.get("y").unwrap(), vec![]).string(), "y");
    assert_eq!(Native::owners(&observed), 1, "released when the task exited");
}
