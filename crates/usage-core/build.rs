fn main() {
    // Expose the shared contract fixture directory to the crate so tests do not
    // depend on the current working directory.
    let manifest_dir = std::path::PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR"),
    );
    if let Some(repository_root) = manifest_dir.parent().and_then(|crates| crates.parent()) {
        let fixtures = repository_root.join("fixtures").join("contracts");
        println!(
            "cargo:rustc-env=AGENTS_USAGE_FIXTURES_DIR={}",
            fixtures.display()
        );
        println!("cargo:rerun-if-changed={}", fixtures.display());
        for entry in std::fs::read_dir(&fixtures).into_iter().flatten().flatten() {
            println!("cargo:rerun-if-changed={}", entry.path().display());
        }
    }
}
