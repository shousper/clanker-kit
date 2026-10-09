# C++ project standards

These rules apply when the task creates a project or changes its build or tool configuration.

## Build system

- Require CMake 3.25 or newer and commit a `CMakePresets.json` file.
- Compile as C++20 with `CMAKE_CXX_STANDARD 20`, `CMAKE_CXX_STANDARD_REQUIRED ON`, and `CMAKE_CXX_EXTENSIONS OFF`.
- The toolchain must provide `<format>`, `<span>`, `<ranges>`, `<stop_token>`, and `std::jthread` with no extra flags. GCC 13, Clang 18 with libstdc++ 13, and Visual Studio 2022 17.2 meet this requirement.
- Pin every dependency by version and hash. Use a package manager such as vcpkg or Conan, or `FetchContent` with `URL_HASH`. Never fetch a moving branch or an unpinned tag.
- Mark third-party include directories as `SYSTEM` so that their warnings stay out of the build.

## Warnings

Every target compiles with these warnings. CI treats warnings as errors: `-Werror`, or `/WX` for Visual Studio.

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

## Hardening and sanitizers

Release builds use these flags, which come from the OpenSSF Compiler Options Hardening Guide. A flag applies only when the condition in its cell is true.

| Protection | GCC and Clang | Visual Studio |
|---|---|---|
| Checked C library calls | `-U_FORTIFY_SOURCE -D_FORTIFY_SOURCE=3` at `-O1` or higher, with glibc 2.34 or newer | |
| Stack canaries | `-fstack-protector-strong` | `/GS`, on by default |
| Stack clash checks | `-fstack-clash-protection` on Linux | |
| Control-flow integrity | `-fcf-protection=full` on x86-64, `-mbranch-protection=standard` on AArch64 | `/guard:cf` for the compiler and the linker, `/CETCOMPAT` for the linker on x64 |
| Zeroed local variables | `-ftrivial-auto-var-init=zero` | |
| Hardened linking | `-Wl,-z,relro,-z,now -Wl,-z,noexecstack` with a Linux linker | |
| Position-independent code | `CMAKE_POSITION_INDEPENDENT_CODE ON` after `check_pie_supported()` | |
| Compiler security checks | | `/sdl` |

- Debug and test builds enable the hardening mode of the standard library: `-D_GLIBCXX_ASSERTIONS` for libstdc++, and `-D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_EXTENSIVE` for libc++.
- CI runs the test suite once with `-fsanitize=address,undefined -fno-sanitize-recover=all -fno-omit-frame-pointer`. Visual Studio supports only `/fsanitize=address`.
- CI runs the concurrency tests once more with `-fsanitize=thread` in a separate build.

## Formatting and static analysis

Commit a `.clang-format` file based on the Google style, and a `.clang-tidy` file. Both tools work on a project that builds with GCC.

```yaml
# .clang-format
BasedOnStyle: Google
Standard: c++20
```

```yaml
# .clang-tidy
Checks: >
  -*, bugprone-*, cert-*, clang-analyzer-*, concurrency-*, cppcoreguidelines-*, misc-*,
  modernize-*, performance-*, portability-*, readability-*,
  -bugprone-easily-swappable-parameters, -cppcoreguidelines-avoid-magic-numbers,
  -cppcoreguidelines-pro-bounds-constant-array-index, -readability-magic-numbers,
  -modernize-use-trailing-return-type
HeaderFilterRegex: '.*/(include|src|tests)/.*'
CheckOptions:
  readability-identifier-length.IgnoredVariableNames: '^(it)$'
```

The CI preset or CI command turns tidy findings into errors with `-warnings-as-errors='*'`.

## Commands

```bash
cmake --preset debug && cmake --build --preset debug
ctest --preset debug --output-on-failure
cmake --preset asan && cmake --build --preset asan && ctest --preset asan
git clang-format --diff
run-clang-tidy -p build/debug -warnings-as-errors='*'
```

## Layout

The tree follows the Pitchfork layout: public headers in `include/`, implementation in `src/`, and separate `tests/`, `benchmarks/`, and `examples/`.

```text
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

- Name a directory after the capability it provides. A grab-bag name such as `utils/` or `common/` hides coupling.
- Put one class, or one set of closely related free functions, in each header.
