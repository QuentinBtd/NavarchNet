fn main() {
    // SQLx embeds migrations at compile time; SQL-only edits must invalidate that binary.
    println!("cargo:rerun-if-changed=../../migrations");
}
