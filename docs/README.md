# Documentation

Tutorials:

- [Quickstart](quickstart.md): where to start, and the authoring loop.
- [Setup](setup.md): tools, and using a module in a web, Android, iOS or Expo app.
- [Headless module](headless.md): native objects passed to and returned from Rust, in React Native and the browser.
- [Draw a triangle](triangle.md): a Rust GPU renderer in a React component.

Reference:

- [Platform support](support.md).
- [Type map](types.md): TypeScript types, Rust equivalents and conversion rules.
- [Generator](generator.md): spec rules, generated interfaces and async methods.
- [Ownership](ownership.md): runtime rules, buffers, native objects, cancellation and teardown.
- [Packaging](packaging.md): module packages, discovery, targets and lock files.
- [Rendering surfaces](surface.md), [logging](logging.md) and [iOS integration](ios.md).
- Example code: [counter](../packages/counter/README.md), [native objects](../packages/meter/README.md), [value types](../packages/values/README.md), [2D rendering](../packages/vello2d/README.md).
- Example module guides: [HTTP](../packages/http/README.md), [key-value storage](../packages/kv/README.md), [BLAKE3](../packages/blake3/README.md), [Bevy](../packages/bevy3d/README.md).

Working on rnrs itself: [development](development.md) and [releasing](releasing.md).
