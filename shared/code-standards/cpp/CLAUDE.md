# C++ Standards

These standards apply to all work on C++ files. Every rule is a requirement. A rule that starts with "If" applies only when its condition is true. Rules cite C++ Core Guidelines IDs, for example (CG R.11), and SEI CERT C and C++ IDs, for example (CERT INT32-C). The guidelines are at https://isocpp.github.io/CppCoreGuidelines/CppCoreGuidelines. Examples omit standard library includes unless the section is about includes.

## Scope and Precedence

- The settings of the project win over this file. These include the language version, the tools and their configuration.
- This file sets the rules for new code where the project has no rule of its own.
- Existing code keeps its local style until a project-wide change.
- Project settings never override the Never rules in this section or the Security rules.
- Never raise the language version of the project.
- Never change the build system or replace a tool of the project unless the task asks for it.
- Never create a tool configuration file in an existing project unless the task asks for it.
- Never reformat or fix a file that the task does not change.
- Never update a lock file unless the task changes a dependency.
- Never relax a compiler, lint, type-check or sanitizer setting to pass a check. Fix the code.
- Never log, print or commit a secret.

If 2 rules in this file conflict, apply this order:

1. Safety and security. No undefined behavior. No unchecked trust boundary.
2. C++ Core Guidelines.
3. SEI CERT C++ Coding Standard.
4. Measured performance. A performance rule never overrides items 1 to 3.

## Dependencies

- Compile as C++20 with `CMAKE_CXX_STANDARD 20`, `CMAKE_CXX_STANDARD_REQUIRED ON` and `CMAKE_CXX_EXTENSIONS OFF`.
- The toolchain must provide `<format>`, `<span>`, `<ranges>`, `<stop_token>` and `std::jthread` with no extra flags. GCC 13, Clang 18 with libstdc++ 13, and Visual Studio 2022 17.2 meet this requirement.
- If the project compiles as C++17 or earlier, apply the rules that compile under its standard. Keep the idiom of the project for the rest.
- If the project compiles as C++23 or later, use the library features its toolchain provides, such as `std::expected` and `std::print`.
- Never introduce C++20 modules.
- If you create a CMake project, require CMake 3.25 or newer and a `CMakePresets.json` file.
- Pin every dependency by version and hash. Use a package manager such as vcpkg or Conan, or `FetchContent` with `URL_HASH`.
- Never fetch a moving branch or an unpinned tag.
- Mark third-party include directories as `SYSTEM` so that their warnings stay out of the build.
- Use the standard library before any other library (CG SL.2).
- If the project has no library of its own for a job, use the default below. Choose any other library by wide adoption and active maintenance (CG P.13).

| Job | Default |
|---|---|
| Unit tests | GoogleTest |
| Benchmarks | Google Benchmark |
| Fuzz tests | libFuzzer, which needs Clang |
| Logging in an application | spdlog |
| Command-line parsing | CLI11 |
| Text formatting | `std::format` |

- A library never logs. It reports through its return values and exceptions.

## Build and Tooling

### Warnings

- Every target compiles with the warnings below. CI treats warnings as errors.
- Visual Studio uses `/W4 /permissive-`, and `/WX` in CI. The GCC and Clang flags have no exact Visual Studio equivalent.

```cmake
if(MSVC)
  target_compile_options(project_name PRIVATE /W4 /permissive-)
else()
  target_compile_options(project_name PRIVATE
    -Wall -Wextra -Wpedantic -Wshadow -Wconversion -Wsign-conversion
    -Wold-style-cast -Wcast-align -Wnon-virtual-dtor -Woverloaded-virtual
    -Wnull-dereference -Wdouble-promotion -Wformat=2 -Wimplicit-fallthrough)
  if(CMAKE_CXX_COMPILER_ID STREQUAL "GNU")
    target_compile_options(project_name PRIVATE
      -Wduplicated-cond -Wduplicated-branches -Wlogical-op -Wuseless-cast)
  endif()
endif()
```

### Hardening and Sanitizers

Release builds use these flags. The GCC and Clang flags come from the OpenSSF Compiler Options Hardening Guide. A flag applies only when the condition in its cell is true.

| Protection | GCC and Clang | Visual Studio |
|---|---|---|
| Checked C library calls | `-U_FORTIFY_SOURCE -D_FORTIFY_SOURCE=3` at `-O1` or higher, with glibc 2.34 or newer | |
| Stack canaries | `-fstack-protector-strong` | `/GS`, on by default |
| Stack clash checks | `-fstack-clash-protection` on Linux | |
| Control-flow integrity | `-fcf-protection=full` on x86-64, `-mbranch-protection=standard` on AArch64 | `/guard:cf` for the compiler and the linker, `/CETCOMPAT` for the linker on x64 |
| Zeroed local variables | `-ftrivial-auto-var-init=zero` | |
| Hardened linking | `-Wl,-z,relro,-z,now -Wl,-z,noexecstack` with a Linux linker | |
| Position-independent code | `CMAKE_POSITION_INDEPENDENT_CODE ON` after `check_pie_supported()`, with CMake | |
| Compiler security checks | | `/sdl` |

- Debug and test builds enable the hardening mode of the standard library: `-D_GLIBCXX_ASSERTIONS` for libstdc++, and `-D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_EXTENSIVE` for libc++.
- CI runs the test suite once with `-fsanitize=address,undefined -fno-sanitize-recover=all -fno-omit-frame-pointer`. Visual Studio supports only `/fsanitize=address`.
- CI runs the concurrency tests once more with `-fsanitize=thread` in a separate build.

### Formatting and Static Analysis

- If the project has a `.clang-format` file, format only the changed lines with `git clang-format`.
- If the project has a `.clang-tidy` file, run clang-tidy on the changed files. Fix every new finding.
- A new project commits a `.clang-format` file based on the Google style, and the `.clang-tidy` file below.
- A `// NOLINT(check-name)` names 1 check and gives its reason on the same line. Never write a `NOLINT` without a check name.
- clang-format and clang-tidy also work on a project that builds with GCC.

```yaml
# .clang-tidy
Checks: >
  -*, bugprone-*, cert-*, clang-analyzer-*, concurrency-*, cppcoreguidelines-*, misc-*,
  modernize-*, performance-*, portability-*, readability-*,
  -bugprone-easily-swappable-parameters, -cppcoreguidelines-avoid-magic-numbers,
  -cppcoreguidelines-pro-bounds-constant-array-index, -readability-magic-numbers,
  -modernize-use-trailing-return-type
WarningsAsErrors: '*'
HeaderFilterRegex: '.*/(include|src|tests)/.*'
CheckOptions:
  readability-identifier-length.IgnoredVariableNames: '^(it)$'
```

### Commands

If the project uses CMake presets, these commands build, test and check a change:

```bash
cmake --preset debug && cmake --build --preset debug
ctest --preset debug --output-on-failure
cmake --preset asan && cmake --build --preset asan && ctest --preset asan
git clang-format --diff
run-clang-tidy -p build/debug
```

## Project Layout

```
project/
├── CMakeLists.txt
├── CMakePresets.json
├── .clang-format
├── .clang-tidy
├── include/project_name/        # Public headers, a directory per component
│   └── network/connection_pool.h
├── src/                         # Implementation, mirrors include/
│   └── network/connection_pool.cpp
├── tests/                       # GoogleTest, a file per unit
│   └── connection_pool_test.cpp
├── benchmarks/                  # Google Benchmark, never in the test binary
└── examples/
```

- The tree follows the Pitchfork layout: public headers in `include/`, implementation in `src/`, and separate `tests/`, `benchmarks/`, and `examples/`.
- Name a directory after the capability it provides. A grab-bag name such as `utils/` or `common/` hides coupling.
- 1 class, or 1 set of closely related free functions, per header.

## Naming

| Item | Style | Example |
|---|---|---|
| Namespace | `snake_case` | `project_name::network` |
| Type, class, struct, alias | `PascalCase` | `ConnectionPool`, `RecordStore` |
| Concept | `PascalCase` | `VectorField` |
| Template parameter | `PascalCase` | `template <typename Allocator>` |
| Enumerator | `PascalCase` | `Orientation::Landscape` |
| Function, method | `snake_case` | `acquire()`, `apply_update()` |
| Variable, parameter | `snake_case` | `remaining_capacity` |
| Data member | `snake_case_` | `connections_`, `mutex_` |
| Constant, `constexpr` variable | `snake_case` | `inline constexpr int max_depth = 10` |
| Macro | `UPPER_SNAKE_CASE` | Include guards only |
| File | `snake_case.h`, `snake_case.cpp` | `connection_pool.h` |

- Types use `PascalCase` and everything else uses `snake_case` as in the standard library (CG NL.10). Never use `ALL_CAPS` except for a macro (CG NL.9).
- Enumerators use `PascalCase` so that names like `Default` or `Delete` never collide with keywords (CG Enum.5).
- Match the length of a name to its scope. A loop index can be `i`. A member or a parameter gets a full word (CG NL.7).
- Use only abbreviations that every C++ programmer knows. These are `i` and `j` for a loop index, `it` for an iterator, and `T` for a template parameter. Never invent an abbreviation such as `cfg` or `msg`.
- A function name is a verb phrase. A variable name is a noun phrase. A `bool` reads as a predicate: `is_open`, `has_capacity`.

```cpp
// Good: full words, intent visible at the call site
double discounted_mean(std::span<const double> values, int periods, double rate);
class AccumulateDatesByPeriod;
auto value = values_by_period.at(period_index);
```

## Design Principles

- A class owns exactly 1 invariant. A function does 1 thing (CG C.2, F.2).
- Add behavior through a new type that satisfies a concept or an interface. Never add a case to a `switch` on type tags (CG C.120, T.10).
- An override keeps the preconditions and postconditions of the base. It never throws where the base promised `noexcept` (CG C.128).
- A caller never depends on a function that it does not call. Use small interfaces and narrow concepts (CG I.25, T.20).
- Depend on an abstract base or a concept. Inject a dependency through the constructor (CG I.25, C.121).
- If a function needs no private access, make it a free function (CG C.4, C.5).
- Use composition. Inherit only to model an is-a relationship that callers use through the base (CG C.120, C.129).
- Never make an object depend on global mutable state, and never write a singleton (CG I.2, I.3).
- If a function needs more than 4 parameters, pass a `struct` (CG I.23).
- If swapping 2 adjacent parameters of the same type changes the result, use a strong type or a `struct` (CG I.24).
- A function passes the clang-tidy check `readability-function-cognitive-complexity` (CG F.3).
- Make a value type regular: copyable, movable and equality-comparable, with no hidden shared state (CG C.61, C.66, T.46).
- Write pure functions. Return the result. Never communicate through hidden state.
- Use a standard algorithm or a range adaptor in place of a hand-written loop (CG ES.1, P.3).
- Use a lambda. Never use `std::bind`.
- Never let a range view outlive the container it views. Never return a view over a local.

```cpp
// Good: the algorithm states the intent, and the shorter range bounds the work
[[nodiscard]] std::vector<double> successive_deltas(std::span<const double> samples) {
  std::vector<double> deltas;
  deltas.reserve(samples.empty() ? 0 : samples.size() - 1);
  std::ranges::transform(samples | std::views::drop(1), samples, std::back_inserter(deltas),
                         [](double current, double previous) { return current - previous; });
  return deltas;
}
```

## Type System

- Make illegal states unrepresentable. Encode a rule in a type so that the compiler enforces it.
- Use `enum class`. Never an unscoped `enum` (CG Enum.3).
- Use a strong type for a domain identifier or a physical quantity in a public signature (CG I.4). A general numeric function takes its values as built-in types.
- Use `std::chrono` for every time point and duration. Never a raw integer of nanoseconds.
- Use `std::byte` for raw memory. Never `char` or `unsigned char`.
- Use `std::optional<T>` for a value that can be absent. Never a sentinel such as `-1` or an empty string.
- Use `std::variant` for a closed set of alternatives. Never `void*`, a tagged `union`, or `std::any`.
- Return a named `struct`. Never `std::pair` or `std::tuple` in a public signature (CG F.21).
- Replace a `bool` parameter with a 2-value `enum class`. A bare `true` at a call site says nothing.
- Mark every converting constructor `explicit`: a constructor that 1 argument can call, other than a copy or move constructor (CG C.46). Never write an implicit conversion operator (CG C.164).

```cpp
// Good: strong types, a struct for same-typed values, chrono, and an enum
template <typename Tag, std::integral Representation>
class Strong {
public:
  constexpr explicit Strong(Representation value) noexcept : value_{value} {}
  [[nodiscard]] constexpr Representation value() const noexcept { return value_; }
  friend constexpr auto operator<=>(Strong, Strong) = default;

private:
  Representation value_;
};

using Pixels = Strong<struct PixelsTag, std::int32_t>;
using DocumentId = Strong<struct DocumentIdTag, std::uint64_t>;
enum class Orientation : std::uint8_t { Portrait, Landscape };

struct Extent {
  Pixels width;
  Pixels height;
};

void configure_capture(Extent extent, Orientation orientation,
                       std::chrono::microseconds exposure);
```

## Resource Management

- Every resource has exactly 1 RAII owner: memory, file, socket, lock, C handle (CG R.1).
- Never call `new` or `delete`. Use `std::make_unique` or `std::make_shared` (CG R.11).
- Never call `malloc` or `free` outside an allocator or a deleter for memory that a C API allocated (CG R.10).
- A raw pointer or reference never owns. It observes (CG R.3, R.4).
- Use a stack object. If the lifetime or the size rules out the stack, use the heap (CG R.5).
- Own a C pointer handle with `std::unique_ptr` and a stateless deleter. Own an integer handle, such as a file descriptor, with a small move-only class (CG R.1).
- A deleter cannot report an error. If you wrote to a file, close it with an explicit call and check the result.
- Default to `std::unique_ptr`. If ownership is shared, use `std::shared_ptr` and say why in a comment (CG R.20, R.21). Break a cycle with `std::weak_ptr` (CG R.24).
- If a function transfers or shares ownership, pass a smart pointer. Otherwise pass `T&`, `T*`, or `std::span` (CG R.30, R.32, R.34).

```cpp
// Good: a C handle owned by unique_ptr with a stateless deleter
struct CurlCleanup {
  void operator()(CURL* handle) const noexcept { curl_easy_cleanup(handle); }
};
using CurlHandle = std::unique_ptr<CURL, CurlCleanup>;

[[nodiscard]] CurlHandle make_curl_handle() {
  CurlHandle handle{curl_easy_init()};
  if (!handle) {
    throw std::runtime_error{"curl_easy_init returned a null handle"};
  }
  return handle;
}

// Good: ownership is visible in the signature
void take_ownership(std::unique_ptr<Connection> connection);
void share_ownership(std::shared_ptr<Cache> cache);   // Shared: the cache outlives any single worker.
void use_only(const Connection& connection);
void use_if_present(const Connection* connection);
```

## Initialization and Constness

- Initialize every variable at its declaration (CG ES.20, CERT EXP53-CPP).
- Use brace initialization `{}` because it rejects narrowing (CG ES.23).
- If the type is `auto` or the initializer already has the declared type, use `=`.
- If a type has an `std::initializer_list` constructor, use braces only for a list of elements. Use parentheses for any other constructor (CG ES.23).
- Declare a variable in the smallest scope, as late as possible (CG ES.5, ES.21).
- Use a default member initializer for a constant default. Never repeat it in each constructor (CG C.48).
- Use `constexpr` for a compile-time value and `const` for a runtime value (CG Con.5).
- If a member function does not change observable state, mark it `const` (CG Con.2).
- Use `mutable` only for a mutex or a cache that does not change observable state.
- Take a read-only string as `std::string_view`. Never store a `std::string_view` beyond the call (CG F.15).

```cpp
// Bad: braces select the initializer-list constructor, giving 1 element with the value 10
std::vector<int> levels{10};

// Good: parentheses for a count, = for a value of the declared type, braces for a conversion
std::vector<int> levels(10);
const int count = compute_count();
inline constexpr std::size_t max_depth{10};
```

## Functions and Parameter Passing

- Pass a cheap type by value. Cheap is at most 2 machine words and trivially copyable (CG F.16).
- Pass any other input as `const T&` (CG F.16).
- Pass an in-out parameter as `T&` (CG F.17).
- Return a result by value. Return a `struct` for more than 1 result. Never an output parameter (CG F.20, F.21).
- Take a sink parameter by value and move it into place (CG F.15). If the type is expensive to move or the function moves only on success, take it as `X&&` (CG F.18).
- Use `T&&` with `std::forward` only in a forwarding template (CG F.19).
- Never write `return std::move(local)`. It disables copy elision (CG F.48).
- Never return a reference or pointer to a local (CG F.43).
- Never `std::move` a `const` object. It silently copies.
- Never read the value of a moved-from object. Assign to it, reset it or destroy it (CERT EXP63-CPP).
- Mark every move constructor and move assignment `noexcept` (CG C.66).
- If a lambda can outlive the scope, never capture by reference (CG F.52, F.53).
- Capture `this` by name. Never `[=]` or `[&]` in a stored lambda (CG F.54).
- If ignoring the result is a bug, mark the function `[[nodiscard]]`.

```cpp
// Good: passing styles
void set_depth(int depth);                              // Cheap: by value
void rebuild(const std::vector<Record>& records);       // Expensive input: const&
void accumulate(Statistics& statistics);                // In-out: non-const&
void set_name(std::string name) { name_ = std::move(name); }  // Sink: by value + move

struct ParseResult {
  Record record;
  std::size_t bytes_consumed;
};
[[nodiscard]] ParseResult parse_record(std::span<const std::byte> bytes);
```

## Classes and Dynamic Polymorphism

- Use the Rule of Zero. Let RAII members give you copy, move and destruction (CG C.20).
- If you write any special member, define or `= delete` all 5 (CG C.21).
- If a type has an invariant, make it a `class`. Make a passive aggregate with no invariant a `struct` (CG C.2, C.8).
- Never expose a data member of a `class`. Never use `protected` data (CG C.9, C.133).
- Never write a trivial getter and setter pair. Make it a `struct` (CG C.131).
- Mark an override `override` or `final`. Never repeat `virtual` on an override (CG C.128).
- Give a polymorphic base a `virtual` destructor, or a `protected` non-virtual destructor (CG C.35).
- Make the copy and move constructors of a polymorphic base `protected`, and delete its copy and move assignment. This prevents slicing and lets a derived class implement `clone()` (CG C.67, CERT OOP51-CPP).
- Never call a virtual function from a constructor or destructor (CG C.82, CERT OOP50-CPP).
- An interface is an abstract class with no data members (CG I.25, C.121). Its public functions are non-virtual and call private virtual functions.
- If the comparison needs no custom logic, default `operator==` and `operator<=>`.
- If a class hides its implementation, declare its destructor and move operations in the header. Define them in the `.cpp`.

```cpp
// Good: interface, non-virtual interface pattern, no slicing, override and final
class Shape {
public:
  virtual ~Shape() = default;
  Shape& operator=(const Shape&) = delete;
  Shape& operator=(Shape&&) = delete;

  [[nodiscard]] double area() const noexcept { return do_area(); }
  [[nodiscard]] std::unique_ptr<Shape> clone() const { return do_clone(); }

protected:
  Shape() = default;
  Shape(const Shape&) = default;
  Shape(Shape&&) = default;

private:
  [[nodiscard]] virtual double do_area() const noexcept = 0;
  [[nodiscard]] virtual std::unique_ptr<Shape> do_clone() const = 0;
};

class Circle final : public Shape {
public:
  explicit Circle(double radius) noexcept : radius_{radius} {}

private:
  [[nodiscard]] double do_area() const noexcept override {
    return std::numbers::pi * radius_ * radius_;
  }
  [[nodiscard]] std::unique_ptr<Shape> do_clone() const override {
    return std::make_unique<Circle>(*this);
  }
  double radius_;
};
```

## Templates, Concepts and Static Polymorphism

- If a template calls an operation on a parameter, constrain that parameter with a concept (CG T.10). A tag type and a pack of base classes need no concept.
- Reuse a standard concept first: `std::integral`, `std::floating_point`, `std::regular`, `std::invocable`, `std::ranges::range`.
- Define a concept by the operations the algorithm uses, and name it for the semantics (CG T.20, T.21, T.26).
- Use `if constexpr` for a compile-time branch. If a concept works, never use SFINAE or tag dispatch.
- Use `static_assert` for a compile-time contract (CG T.150).
- Use an `auto` parameter only in a lambda of 1 or 2 lines.
- Use CRTP for static polymorphism. If the project compiles as C++23 and the toolchain provides deducing `this`, use it.
- If a policy is fixed at compile time, pass it as a template parameter.
- Keep a template in the header. If a build-time measurement shows a gain, move its explicit instantiations to a `.cpp`.
- Never write a macro for code. Use `constexpr`, `inline`, or a template (CG ES.30, ES.31).
- Confine a C callback with `void*` to the adapter layer. The public API takes a constrained callable.
- A callback that crosses a C boundary is `noexcept`. An exception never unwinds through a C frame.

```cpp
// Good: the public API is typed, and void* exists only inside the C adapter
struct Interval {
  double lower;
  double upper;
};

extern "C" double c_integrate(double (*callback)(double, void*), void* context,
                              Interval interval);

template <typename Function>
concept NothrowRealFunction = std::is_nothrow_invocable_r_v<double, Function&, double>;

template <NothrowRealFunction Function>
[[nodiscard]] double integrate(Function function, Interval interval) {
  auto trampoline = [](double point, void* context) noexcept -> double {
    return (*static_cast<Function*>(context))(point);
  };
  return c_integrate(trampoline, std::addressof(function), interval);
}
```

### Choosing a Dispatch Mechanism

| Situation | Mechanism |
|---|---|
| The set of types is known at compile time, or the call is inside a loop on the performance-critical path | Template parameter with a concept |
| Closed set of alternatives chosen at runtime | `std::variant` with `std::visit` |
| Open set, plugin, or ABI boundary | Abstract base owned by `std::unique_ptr<Base>` |
| Stored callback off the performance-critical path | `std::function` |
| Stored callback on the performance-critical path | Template parameter |

## Error Handling and Contracts

- Throw an exception for a failure the caller cannot handle locally (CG E.2). Never use an exception for control flow (CG E.3).
- Return `std::optional<T>` for an absent value that is a normal outcome, such as "not found". If the project has `std::expected` or its own expected type, return it for an error that the caller handles.
- Never throw on the performance-critical path. A function there is `noexcept` and reports failure through its return value, such as `std::optional` or a status `enum class`.
- Throw by value. Catch by `const&` (CG E.15, CERT ERR61-CPP).
- Derive every project exception from `std::runtime_error` or `std::logic_error` (CG E.14).
- Wrap an OS or C library error in `std::system_error` with its `std::error_code`.
- If any input can make a function throw, never mark it `noexcept`. A violated `noexcept` calls `std::terminate` (CG F.6, CERT ERR55-CPP).
- Never throw from a destructor, a move operation, or `swap` (CG C.36, C.66, C.84, CERT DCL57-CPP).
- Never catch and ignore. An empty `catch` is a defect.
- Use RAII for cleanup. Never `try` and `catch` for cleanup (CG E.6).
- Give every function at least the basic exception guarantee: after an exception, no resource leaks and every invariant holds.
- Check preconditions at a trust boundary with an explicit test (CG I.5, I.6).
- Check an internal invariant with `assert`. An assertion never has a side effect.
- An error message names the operation, the bad value, and the expected value.

```cpp
class ConfigurationError : public std::runtime_error {
  using std::runtime_error::runtime_error;
};

// Good: an optional for a normal absence, an exception for a broken environment
[[nodiscard]] std::optional<User> find_user(std::string_view name);

[[nodiscard]] Configuration load_configuration(const std::filesystem::path& path) {
  std::ifstream file{path};
  if (!file) {
    throw ConfigurationError{std::format("cannot open configuration file {}", path.string())};
  }
  return parse(file);
}

// Good: a specific type, context, and a caller that can act
[[nodiscard]] ExitCode run_once() {
  try {
    execute();
  } catch (const ConfigurationError& error) {
    spdlog::error("execute failed: {}", error.what());
    return ExitCode::BadConfiguration;
  }
  return ExitCode::Success;
}
```

## Bounds, Integer and Floating-Point Safety

### Bounds

- Never use a C array or pointer arithmetic. Use `std::array`, `std::vector`, `std::span` (CG ES.27, ES.42).
- Take a contiguous range parameter as `std::span<const T>` (CG F.24).
- Iterate with a range-for or an algorithm. If the index is the result, use an index loop (CG ES.55, ES.71).
- Check an index from outside the trust boundary before use. Use `.at()` or an explicit test.
- Inside the boundary, use `[]` and rely on the hardened standard library in debug and test.
- If the project compiles as C++23 and the toolchain provides `std::mdspan`, use it for a multi-dimensional view. Otherwise index 1 contiguous buffer through 1 accessor function.

### Integers

- Use a signed type for arithmetic. Use unsigned only for bit patterns and for standard library sizes (CG ES.100 to ES.107).
- Never mix signed and unsigned in 1 expression. `-Wsign-conversion` is an error (CERT INT31-C).
- Compare mixed signedness with `std::cmp_less` and its siblings.
- If you need an index, compare `std::size_t` with `.size()`, or `std::ptrdiff_t` with `std::ssize()`. Never mix the 2 in 1 loop.
- If the width matters, use `std::int32_t` and its siblings with the `std::` prefix. Never `long`.
- Check for overflow before arithmetic on untrusted input. Signed overflow is undefined behavior (CERT INT30-C, INT32-C).
- Narrow with an explicit checked conversion. Never a bare `static_cast` on untrusted input (CG ES.46).
- Use `std::numeric_limits`. Never the `INT32_MAX` macros.

```cpp
// Good: checked narrowing and checked addition
template <std::integral To, std::integral From>
[[nodiscard]] constexpr To narrow(From value) {
  if (!std::in_range<To>(value)) {
    throw std::out_of_range{std::format("narrow: {} is outside [{}, {}]", value,
        std::numeric_limits<To>::min(), std::numeric_limits<To>::max())};
  }
  return static_cast<To>(value);
}

[[nodiscard]] constexpr std::optional<std::int64_t>
checked_add(std::int64_t left, std::int64_t right) noexcept {
  constexpr auto max_value = std::numeric_limits<std::int64_t>::max();
  constexpr auto min_value = std::numeric_limits<std::int64_t>::min();
  if ((right > 0 && left > max_value - right) || (right < 0 && left < min_value - right)) {
    return std::nullopt;
  }
  return left + right;
}
```

### Floating Point

- Never compare floating-point values with `==`. Compare with a named, scaled tolerance.
- Check `std::isfinite` on every floating-point input at a trust boundary.
- Keep 1 precision, `double`. If a measurement shows that memory bandwidth requires `float`, use it.
- Never enable `-ffast-math` for the whole project. Enable a specific flag per target with a comment.
- If a simulation must reproduce a result across runs, fix the reduction order.
- Seed every random engine explicitly. A library takes the seed as a parameter. An application logs the seed. Use `std::mt19937_64`. Never `rand()` (CERT MSC50-CPP, MSC51-CPP).
- Never use `<random>` for a secret. Use a vetted cryptographic library.

```cpp
// Good: tolerance scaled by magnitude, in a type that a caller cannot swap with a value
struct RelativeTolerance {
  double value;
};

[[nodiscard]] bool nearly_equal(double left, double right, RelativeTolerance tolerance) noexcept {
  const double scale = std::max({1.0, std::abs(left), std::abs(right)});
  return std::abs(left - right) <= tolerance.value * scale;
}
```

## Concurrency

- A data race is undefined behavior. Protect every shared mutable object or make it immutable (CG CP.2).
- Use message passing and immutable data in place of shared mutable state (CG CP.3).
- Use `std::jthread`. Never `std::thread::detach` (CG CP.25, CP.26).
- Lock with `std::scoped_lock` or `std::unique_lock`. Never call `lock()` by hand (CG CP.20, CP.21).
- Never call unknown code, block on I/O, or wait on a user callback while holding a lock (CG CP.22).
- Always wait on a condition variable with a predicate (CG CP.42).
- Never use `volatile` for synchronization (CG CP.8, CP.200).
- Use `std::call_once` or a function-local `static` to initialize once (CG CP.110).
- Keep `std::atomic` operations at the default `seq_cst`. A weaker order needs a comment that states what the order protects.
- If no measurement proves that a lock is the bottleneck, never write lock-free code (CG CP.100). The ring below is the accepted low-risk pattern.
- Align each field that a different thread writes to its own cache line. Use a project constant such as `cache_line_size` with the value 64. GCC warns when a header uses `std::hardware_destructive_interference_size`.
- Use `std::latch` and `std::barrier` for phase synchronization.
- Never write a capturing lambda that is a coroutine (CG CP.51).
- Never hold a lock across a `co_await` or a `co_yield` (CG CP.52).
- Never take a reference, pointer, `std::string_view` or `std::span` parameter in a coroutine. Take each parameter as an owning value (CG CP.53).
- Never `std::async` without keeping the future. Its destructor blocks.

```cpp
// Good: mutex-protected queue with stop support
template <std::movable Item>
class BlockingQueue {
public:
  void push(Item item) {
    {
      const std::scoped_lock lock{mutex_};
      items_.push_back(std::move(item));
    }
    ready_.notify_one();
  }

  [[nodiscard]] std::optional<Item> pop(std::stop_token stop) {
    std::unique_lock lock{mutex_};
    if (!ready_.wait(lock, stop, [this] { return !items_.empty(); })) {
      return std::nullopt;
    }
    Item item = std::move(items_.front());
    items_.pop_front();
    return item;
  }

private:
  std::deque<Item> items_;
  std::mutex mutex_;
  std::condition_variable_any ready_;
};

// Good: single-producer single-consumer ring
inline constexpr std::size_t cache_line_size{64};

template <typename Item, std::size_t Capacity>
  requires std::default_initializable<Item> && std::is_nothrow_move_constructible_v<Item> &&
           std::is_nothrow_move_assignable_v<Item> && (Capacity >= 2) &&
           (std::has_single_bit(Capacity))
class SpscRing {
public:
  [[nodiscard]] bool try_push(Item&& item) noexcept {
    const std::size_t head = head_.load(std::memory_order_relaxed);  // Relaxed: only the producer writes head_.
    const std::size_t next = (head + 1) & mask_;
    if (next == tail_.load(std::memory_order_acquire)) {  // Acquire: the consumer is done with this slot.
      return false;
    }
    slots_[head] = std::move(item);
    head_.store(next, std::memory_order_release);  // Release: publishes slots_[head].
    return true;
  }

  [[nodiscard]] std::optional<Item> try_pop() noexcept {
    const std::size_t tail = tail_.load(std::memory_order_relaxed);  // Relaxed: only the consumer writes tail_.
    if (tail == head_.load(std::memory_order_acquire)) {  // Acquire: the producer has published this slot.
      return std::nullopt;
    }
    Item item = std::move(slots_[tail]);
    tail_.store((tail + 1) & mask_, std::memory_order_release);  // Release: frees the slot for the producer.
    return item;
  }

private:
  static constexpr std::size_t mask_ = Capacity - 1;
  std::array<Item, Capacity> slots_{};
  alignas(cache_line_size) std::atomic<std::size_t> head_{0};
  alignas(cache_line_size) std::atomic<std::size_t> tail_{0};
};

// Bad: detached thread, manual lock, wait without predicate, volatile flag
std::thread{worker}.detach();
mutex_.lock(); /* ... */ mutex_.unlock();
ready_.wait(lock);
volatile bool stop_requested;
```

## Performance

- Measure before you change. Never claim a speedup without a benchmark result. Keep the benchmark that proves the gain (CG Per.1, Per.2, Per.6).
- Design the data layout first. Contiguous storage and predictable access beat clever code (CG Per.19).
- Move work to compile time with `constexpr` and `consteval` (CG Per.11).
- Write `'\n'`. Never write `std::endl`, which flushes the stream.

### Performance-Critical Path

A function is on the performance-critical path if the project marks it so in its documentation or code. It is also on that path if a profile shows that it dominates run time. On that path:

- Never allocate. Preallocate at startup. Use `reserve`, an object pool or a `std::pmr` arena.
- Never take a lock, make a system call, throw, format text or write to a file.
- Never use type erasure such as `std::function`. Never copy a `std::shared_ptr`.
- Never call a virtual function inside a loop.
- Never use `std::map`, `std::list` or `std::unordered_map`. Use a sorted `std::vector` with `std::ranges::lower_bound`.
- Use a template parameter in place of a runtime branch (CG Per.10).
- Log a fixed-size binary record into a ring buffer. Format it on another thread.
- Use `std::chrono::steady_clock` for durations. Never `system_clock`.
- If you add `[[likely]]` or `[[unlikely]]`, add profile evidence and a benchmark in the same change.
- Use structure-of-arrays for numeric data. Keep a matrix in 1 contiguous buffer, never a vector of vectors.

```cpp
// Good: structure of arrays in a class that keeps every array the same length
class Particles {
public:
  explicit Particles(std::size_t count)
      : position_x_(count), position_y_(count), velocity_x_(count), velocity_y_(count) {}

  void advance(double step) noexcept {
    const auto moved = [step](double position, double velocity) {
      return position + velocity * step;
    };
    std::ranges::transform(position_x_, velocity_x_, position_x_.begin(), moved);
    std::ranges::transform(position_y_, velocity_y_, position_y_.begin(), moved);
  }

private:
  std::vector<double> position_x_;
  std::vector<double> position_y_;
  std::vector<double> velocity_x_;
  std::vector<double> velocity_y_;
};

// Good: a per-job arena with no heap fallback, and a size check so that reserve never throws
[[nodiscard]] bool process_job(std::span<const Reading> readings) noexcept {
  alignas(Sample) std::array<std::byte, 1 << 16> storage{};
  if (readings.size() > storage.size() / sizeof(Sample)) {
    return false;
  }
  std::pmr::monotonic_buffer_resource arena{storage.data(), storage.size(),
                                            std::pmr::null_memory_resource()};
  std::pmr::vector<Sample> samples(&arena);
  samples.reserve(readings.size());
  std::ranges::transform(readings, std::back_inserter(samples), to_sample);
  return publish(samples);
}

// Bad: allocation, formatting and a shared_ptr copy on the performance-critical path
void on_frame(std::shared_ptr<Frame> frame) {
  auto rows = std::make_unique<std::vector<Row>>();
  spdlog::info("frame {}", frame->sequence());
}
```

## Casts and Raw Memory

- Never use a C-style cast (CG ES.48, ES.49).
- Use `static_cast` for a value conversion. Check narrowing first (CG ES.46).
- Replace a `dynamic_cast` with a virtual function or `std::variant` (CG C.146). If a `dynamic_cast` remains, cast to a pointer and test for `nullptr` (CG C.148).
- Use `reinterpret_cast` only for memory-mapped hardware, or for an OS or standard library I/O call that requires it. Put the reason in a comment on the same line.
- Never cast away `const` (CG ES.50).
- Reinterpret bits with `std::bit_cast`. Never through `reinterpret_cast` or a `union` (CG C.183, CERT EXP39-C).
- Decode wire data in 3 steps: check the length, `std::memcpy` into a `struct` of fixed-width integers, then convert the byte order. The conversion tests `std::endian::native`. Reject padding in the `struct` with a `static_assert` of `std::has_unique_object_representations_v`.
- Never pass a null pointer to `std::memcpy`, even for 0 bytes. An empty span can return a null `.data()`.

```cpp
// Good: named casts and safe punning
const auto ratio = static_cast<double>(numerator) / static_cast<double>(denominator);
const auto bits = std::bit_cast<std::uint32_t>(sample);

[[nodiscard]] constexpr std::uint32_t from_big_endian(std::uint32_t value) noexcept {
  if constexpr (std::endian::native == std::endian::big) {
    return value;
  } else {
    return ((value & 0x000000FFU) << 24U) | ((value & 0x0000FF00U) << 8U) |
           ((value & 0x00FF0000U) >> 8U) | ((value & 0xFF000000U) >> 24U);
  }
}

[[nodiscard]] std::optional<Header> decode_header(std::span<const std::byte> bytes) noexcept {
  static_assert(std::has_unique_object_representations_v<Header>);
  if (bytes.size() < sizeof(Header)) {
    return std::nullopt;
  }
  Header header{};
  std::memcpy(&header, bytes.data(), sizeof(Header));
  header.sequence = from_big_endian(header.sequence);
  return header;
}

// Bad: alignment, aliasing, and endianness are all undefined here
const Header* header = reinterpret_cast<const Header*>(bytes.data());
const auto bits = *(std::uint32_t*)&sample;
```

## Security

- Treat every byte from a network, a file, an environment variable, or a user as untrusted.
- Check a length before every index, copy, or allocation size that the length controls. Check an integer for overflow before it sizes an allocation or an offset.
- Format only with a compile-time format string, which `std::format` enforces. Never pass user data as a format string (CERT FIO30-C).
- Never compose a shell command. Spawn a process with an argument vector through 1 wrapper (CERT ENV33-C).
- Check and open a file in 1 operation. A separate `exists()` then `open()` is a race (CERT FIO45-C).
- Before you serve a file, resolve its path with `std::filesystem::canonical` and compare it with the canonical root, component by component. A string prefix test accepts `/srv/data-x` for `/srv/data`. Open the resolved path, never the candidate.
- Never store a secret in source, a test, or a log. Read it from the environment or a secret store.
- Wipe a secret with `explicit_bzero` or `sodium_memzero`. The compiler removes a plain `memset` (CERT MSC06-C).
- Compare a secret in constant time.
- Never implement cryptography. Use a vetted library.
- Fuzz every parser that reads untrusted bytes.
- Never "fix" undefined behavior with `-fno-strict-aliasing` or `-fwrapv`. Fix the code.

| Never | Use |
|---|---|
| `gets`, `strcpy`, `strcat`, `sprintf`, `vsprintf`, `strncpy` | `std::string`, `std::string_view`, `std::format_to_n` |
| `printf`, `fprintf` and `sprintf` with any format | `std::format`, `std::format_to_n` |
| `atoi`, `atof`, `strtol` | `std::from_chars` |
| `system`, `popen` | `posix_spawn` behind a project wrapper |
| `tmpnam`, `mktemp` | `mkstemp` behind a project wrapper |

```cpp
// Bad: user-controlled format string, unchecked length, check-then-open race
printf(user_message.c_str());
std::ranges::copy(packet.first(packet_length), buffer.begin());
if (std::filesystem::exists(path)) { std::ifstream file{path}; }

// Good
void show(std::string_view user_message) { std::cout << user_message; }

[[nodiscard]] bool copy_packet(std::span<const std::byte> packet, std::size_t packet_length,
                               std::span<std::byte> buffer) noexcept {
  if (packet_length > packet.size() || packet_length > buffer.size()) {
    return false;
  }
  std::ranges::copy(packet.first(packet_length), buffer.begin());
  return true;
}

class ServedRoot {
public:
  explicit ServedRoot(const std::filesystem::path& root)
      : root_{std::filesystem::canonical(root)} {}

  [[nodiscard]] std::optional<std::filesystem::path> resolve(
      const std::filesystem::path& candidate) const {
    std::error_code error;
    auto resolved = std::filesystem::canonical(candidate, error);
    if (error || std::ranges::mismatch(root_, resolved).in1 != root_.end()) {
      return std::nullopt;
    }
    return resolved;
  }

private:
  std::filesystem::path root_;
};
```

## Headers and Namespaces

- A header ends in `.h` and a source file in `.cpp`. A template implementation lives in the `.h` or an `.ipp` included at its end (CG SF.1).
- Guard every header with an include guard named after its path (CG SF.8).
- Make every header self-contained. It compiles alone (CG SF.11).
- Include what you use. Never rely on a transitive include (CG SF.10).
- A `.cpp` includes its own header first, so that the header proves it is self-contained (CG SF.5). A test file treats the header of its unit as its own.
- Order includes as the Google style does: own header, C system headers, C++ standard library, other libraries, project headers. Separate the groups with a blank line.
- Use quotes for project headers and angle brackets for everything else (CG SF.12).
- Never write `using namespace` in a header or at file scope in a `.cpp` (CG SF.7). Inside a function body, use it only for a literals namespace such as `std::chrono_literals`.
- Put every project symbol in the project namespace. Put internals in `namespace detail` (CG SF.20).
- Give internal linkage with an unnamed namespace in a `.cpp`. Never `static` at file scope. Never an unnamed namespace in a header (CG SF.21, SF.22).
- Declare a header constant `inline constexpr`. Declare a header function `inline` or as a template.
- Forward-declare a project type to cut an include. Never forward-declare a standard library type.

```cpp
// Good: include/project_name/network/connection_pool.h
#ifndef PROJECT_NAME_NETWORK_CONNECTION_POOL_H
#define PROJECT_NAME_NETWORK_CONNECTION_POOL_H

#include <span>
#include <vector>

#include "project_name/network/connection.h"

namespace project_name::network {

inline constexpr int max_connections = 64;

class ConnectionPool {
public:
  [[nodiscard]] Connection& acquire();
  [[nodiscard]] std::span<const Connection> connections() const noexcept;

private:
  std::vector<Connection> connections_;
};

}  // namespace project_name::network

#endif  // PROJECT_NAME_NETWORK_CONNECTION_POOL_H
```

## Documentation and Comments

- If the name and signature of a public declaration do not state its contract, document it with a `///` comment. The first sentence is the brief.
- If the signature does not already say it, add `@param`, `@return`, or `@throws`.
- Never say in a comment what the code states clearly (CG NL.1).
- State intent and reasons in a comment, not mechanics (CG NL.2).
- Never leave commented-out code. Version control keeps history.
- Never put an author or a date in a comment. Version control records them.
- Never commit a to-do comment. Track open work outside the source.

```cpp
// Good: states a reason the code cannot show
// The broker drops a connection idle for 30 s, so 10 s keeps it alive with margin.
inline constexpr auto keep_alive_interval = std::chrono::seconds{10};

/// Returns the records younger than `max_age`, in their original order.
[[nodiscard]] std::vector<Record> retained(std::span<const Record> records,
                                           std::chrono::seconds max_age);
```

## Testing

- If the project already uses a test framework, use it. Otherwise use GoogleTest. Name the file after the unit plus `_test.cpp`.
- Name a test `TEST(UnitTest, BehaviorUnderCondition)` in `PascalCase`. Never put an underscore in a test suite or test name. The GoogleTest docs reserve underscores.
- Start every test with a `///` comment that states its objective.
- Give every assertion a `<<` message that says what failed.
- Test 1 behavior per test. Arrange, act, assert, in that order.
- Compare floating-point values with `EXPECT_NEAR` and a named tolerance. Never `EXPECT_EQ`.
- Test through the public API. Inject a test double through an abstract interface or a template parameter. Use GoogleMock only against an abstract interface.
- Cover a contract violation with `EXPECT_DEATH` in a debug build.
- Use `TEST_P` for a table of cases.

```cpp
// Good: tests/blocking_queue_test.cpp
#include "project_name/concurrency/blocking_queue.h"

#include <gtest/gtest.h>

namespace project_name {
namespace {

/// A stopped, empty queue must return no item instead of blocking.
TEST(BlockingQueueTest, PopReturnsNulloptAfterStopRequested) {
  BlockingQueue<int> queue;
  std::stop_source stop_source;
  stop_source.request_stop();

  const std::optional<int> item = queue.pop(stop_source.get_token());

  EXPECT_FALSE(item.has_value()) << "pop() returned an item from an empty, stopped queue.";
}

}  // namespace
}  // namespace project_name
```
