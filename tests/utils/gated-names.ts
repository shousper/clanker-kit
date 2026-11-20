/** One file name per pattern family the standards gate maps to a language (gate_units_for in
 *  shared/hooks/standards-gate.sh). Hook prefilters must let every one through. Tailwind
 *  names need a tailwind.config.* signal and .h / CMake names need a C++ source nearby. */
export const GATED_NAMES = [
  "main.go", "go.mod", "go.sum",
  "lib.rs", "Cargo.toml", "clippy.toml", "rust-toolchain.toml",
  "main.tf", "main.tofu", "main.tofu.json", "vars.tfvars",
  "app.py", "stubs.pyi", "pyproject.toml",
  "a.cpp", "a.cc", "a.cxx", "a.hpp", "a.hh", "a.hxx", "a.ipp", "a.tpp", "a.inl", "a.h",
  "CMakeLists.txt", "tools.cmake", "CMakePresets.json", ".clang-tidy", ".clang-format",
  "app.css", "App.tsx", "App.jsx", "App.vue", "App.svelte", "App.astro", "index.html",
];

/** File names no language maps to. */
export const UNGATED_NAMES = ["README.md", "foo.ts", "Makefile", "notes.txt"];
