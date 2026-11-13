fn main() {
    // The user guide is embedded from public/octopolis-guide.html, which `npm run guide` builds. A plain cargo
    // build that has not run it yet gets a placeholder page, so the app always compiles.
    let guide = std::path::Path::new("../public/octopolis-guide.html");
    println!("cargo:rerun-if-changed=../public/octopolis-guide.html");
    if !guide.exists() {
        let _ = std::fs::create_dir_all("../public");
        let _ = std::fs::write(guide, "<!doctype html><html><head><meta charset=\"utf-8\"><title>Octopolis guide</title></head><body><p>The guide was not built into this copy of Octopolis. Run <code>npm run guide</code> and rebuild.</p></body></html>");
    }
    tauri_build::build()
}
