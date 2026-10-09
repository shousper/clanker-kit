# C++ standards

When two rules conflict, apply this order:

1. Safety and security: no undefined behavior, no unchecked trust boundary.
2. C++ Core Guidelines.
3. SEI CERT C++ Coding Standard.
4. Measured performance. It never overrides items 1 to 3.

## Dependencies

- New projects compile as C++20. Under C++17, use only the rules that compile. Under C++23, use `std::expected` when the toolchain has it.
- Never introduce C++20 modules.
- A library never logs. It reports through return values and exceptions.

Where the project has no library for a job, use the default:

| Job | Default |
|---|---|
| Unit tests | GoogleTest |
| Benchmarks | Google Benchmark |
| Fuzz tests | libFuzzer, which needs Clang |
| Logging in an app | spdlog |
| Command-line parsing | CLI11 |
| Text formatting | `std::format` |

## Formatting and suppressions

- Format only changed lines with `git clang-format`.
- Write `// NOLINT(check-name)` with one check name and the reason on the same line.

## Naming

| Item | Style |
|---|---|
| Namespace, function, variable, parameter, constant | `snake_case` |
| Type, alias, concept, template parameter, enumerator | `PascalCase` |
| Data member | `snake_case_` |
| Macro | `UPPER_SNAKE_CASE`, for include guards only |

Enumerators use `PascalCase` so that `Default` and `Delete` never collide with keywords.

## Design principles

- A class owns one invariant.
- Extend through a concept or an interface. Never add a case to a `switch` on type tags.
- If a function needs no private access, make it a free function.
- Inject dependencies through the constructor.
- Never write a singleton or use global mutable state.
- Past 4 parameters, or when swapping two adjacent same-typed parameters changes the result, pass a `struct` or strong types.
- Make a value type regular: copyable, movable, and equality-comparable, with no hidden shared state.
- Never let a view outlive its container or return a view over a local.

## Type system

- Use a strong type for a domain identifier or a physical quantity in a public signature.
- Use `std::chrono` for every time point and duration, never a raw integer.
- Use `std::byte` for raw memory, never `char`.
- Use `std::optional` for an absent value, never a sentinel such as `-1`.
- Use `std::variant` for a closed set of alternatives, never `void*` or `std::any`.
- Return a named `struct`, never `std::pair` or `std::tuple` in a public signature.
- Replace a `bool` parameter with a two-value `enum class`.
- Mark every converting constructor `explicit`.

```cpp
// Good: distinct types catch a swapped argument
template <typename Tag, std::integral Representation>
class Strong {
public:
  constexpr explicit Strong(Representation value) noexcept : value_{value} {}

private:
  Representation value_;
};

using Pixels = Strong<struct PixelsTag, std::int32_t>;
```

## Resource management

- Every `shared_ptr` states in a comment why ownership is shared.
- Own a C pointer handle with `std::unique_ptr` and a stateless deleter.
- A deleter can't report an error. Close a written file explicitly and check the result.

## Initialization

- With a `std::initializer_list` constructor, braces build a list of elements. Use parentheses for any other constructor.

```cpp
std::vector<int> bad{10};   // Bad: one element
std::vector<int> good(10);  // Good: ten elements
```

## Classes

- Give a polymorphic base public non-virtual functions that call private virtual functions.
- Make the copy and move constructors of a polymorphic base `protected` and delete its assignment to prevent slicing.

```cpp
// Good: non-virtual interface, no slicing
class Shape {
public:
  virtual ~Shape() = default;
  Shape& operator=(const Shape&) = delete;
  Shape& operator=(Shape&&) = delete;

  double area() const noexcept { return do_area(); }

protected:
  Shape() = default;
  Shape(const Shape&) = default;
  Shape(Shape&&) = default;

private:
  virtual double do_area() const noexcept = 0;
};
```

## Templates and dispatch

- Constrain a template parameter with a concept, never SFINAE.
- Use `void*` only in the C adapter layer. A callback that crosses a C boundary is `noexcept`.

| Situation | Mechanism |
|---|---|
| Types known at compile time, or a call in a hot loop | Template parameter with a concept |
| Closed set chosen at runtime | `std::variant` with `std::visit` |
| Open set, plugin, or ABI boundary | Abstract base owned by `std::unique_ptr` |
| Stored callback | `std::function`, or a template parameter on the critical path |

## Error handling

- Throw for a failure the caller can't handle locally, never for control flow.
- Return `std::optional` for an absence that is a normal outcome. Return `std::expected` or the project's expected type for an error the caller handles.
- Never mark a function `noexcept` if any input can make it throw.
- Check an internal invariant with a side-effect-free `assert`.

```cpp
// Good: a specific type and context
Configuration load(const std::filesystem::path& path) {
  std::ifstream file{path};
  if (!file) {
    throw ConfigurationError{std::format("cannot open {}", path.string())};
  }
  return parse(file);
}
```

## Bounds, integers, and floating point

- Check an index from outside the trust boundary with `.at()` or an explicit test.
- Use a signed type for arithmetic. Use unsigned only for bit patterns and standard library sizes.
- Compare mixed signedness with `std::cmp_less` and its siblings.
- Narrow with a checked conversion, never a bare `static_cast` on untrusted input.
- Never compare floating-point values with `==`. Use a named, scaled tolerance.
- Never enable `-ffast-math` for a whole project. Enable a flag per target with a comment.
- Seed every random engine explicitly with `std::mt19937_64`, never `rand()`.

```cpp
// Good: checked narrowing
template <std::integral To, std::integral From>
constexpr To narrow(From value) {
  if (!std::in_range<To>(value)) {
    throw std::out_of_range{"narrow: value out of range"};
  }
  return static_cast<To>(value);
}
```

## Concurrency

- Use `std::jthread`, never `std::thread::detach`.
- Lock with `std::scoped_lock`.
- Never call unknown code, block on I/O, or wait on a callback while holding a lock.
- Wait on a condition variable with a predicate.
- Keep `std::atomic` operations at `seq_cst`. A weaker order needs a comment that states what it protects.
- Write lock-free code only when a measurement shows the lock is the bottleneck.
- Never write a capturing lambda that is a coroutine. Never hold a lock across `co_await`.
- Take every coroutine parameter as an owning value, never a reference, pointer, `std::string_view`, or `std::span`.
- Keep the future from `std::async`, because its destructor blocks.

## Performance

Measure before you change, and keep the benchmark that proves a gain. On the performance-critical path, which the project marks or a profile shows:

- Never allocate. Preallocate with `reserve`, an object pool, or a `std::pmr` arena.
- Never take a lock, make a system call, throw, format text, or write to a file.
- Never use `std::function` or copy a `std::shared_ptr`.
- Never call a virtual function inside a loop.
- Never use `std::map`, `std::list`, or `std::unordered_map`. Use a sorted `std::vector`.
- Log a fixed-size binary record into a ring buffer and format it on another thread.
- Use structure-of-arrays for numeric data, and one contiguous buffer for a matrix.

## Casts and raw memory

- Replace a `dynamic_cast` with a virtual function or `std::variant`. If one remains, cast a pointer and test for `nullptr`.
- Use `reinterpret_cast` only for memory-mapped hardware or an OS call that requires it, with the reason in a comment on the same line.
- Reinterpret bits with `std::bit_cast`, never `reinterpret_cast` or a `union`.
- Decode wire data in three steps: check the length, `std::memcpy` into a `struct` of fixed-width integers, then convert the byte order with `std::endian::native`. Reject padding with `std::has_unique_object_representations_v`.

## Security

- Check a length before every index, copy, or allocation it controls, and check for overflow before an integer sizes one.
- Never compose a shell command. Spawn a process with an argument vector through one wrapper.
- Check and open a file in one operation. A separate `exists()` then `open()` is a race.
- Before you serve a file, compare its canonical path with the canonical root component by component, because a string prefix test accepts `/srv/data-x` for `/srv/data`. Open the resolved path, never the candidate.
- Wipe a secret with `explicit_bzero` or `sodium_memzero`, because the compiler removes a plain `memset`. Compare a secret in constant time.
- Never use `<random>` for a secret.
- Never "fix" undefined behavior with `-fno-strict-aliasing` or `-fwrapv`.

| Never | Use |
|---|---|
| `gets`, `strcpy`, `strcat`, `sprintf`, `strncpy` | `std::string`, `std::format_to_n` |
| `printf`, `fprintf` | `std::format` |
| `atoi`, `atof`, `strtol` | `std::from_chars` |
| `system`, `popen` | `posix_spawn` behind a wrapper |
| `tmpnam`, `mktemp` | `mkstemp` behind a wrapper |

## Headers and namespaces

- A header ends in `.h` and a source file in `.cpp`.
- A `.cpp` includes its own header first.
- Order includes as the Google style does, with a blank line between groups.
- Use quotes for project headers and angle brackets for everything else.
- Never write `using namespace` in a header or at file scope in a `.cpp`.
- Put every project symbol in the project namespace and internals in `namespace detail`.
- Give internal linkage with an unnamed namespace in a `.cpp`, never file-scope `static`.

## Testing

- Use GoogleTest when the project has no framework. Name the file after the unit plus `_test.cpp`.
- Name a test `TEST(UnitTest, BehaviorUnderCondition)` in `PascalCase` with no underscore, which GoogleTest reserves.
- Compare floating-point values with `EXPECT_NEAR` and a named tolerance.
- Inject a test double through an abstract interface or a template parameter.
- Cover a contract violation with `EXPECT_DEATH` in a debug build.
- Use `TEST_P` for a table of cases.

```cpp
// Good
TEST(ParserTest, RejectsEmptyInput) {
  EXPECT_FALSE(parse("").has_value());
}
```
