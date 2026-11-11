//! Times directory enumeration and listing encoding on a real folder.
//!
//!     cargo run --release -p octo-core --example bench_list -- C:\Windows\WinSxS

use std::path::PathBuf;
use std::time::Instant;

use octo_core::codec::BatchEncoder;

const RUNS: usize = 5;

fn main() {
    let dir = std::env::args().nth(1).map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows\System32"));
    let mut best_enum = f64::MAX;
    let mut best_encode = f64::MAX;
    let mut count = 0usize;
    let mut bytes = 0usize;

    for _ in 0..RUNS {
        let t = Instant::now();
        let mut n = 0usize;
        octo_core::enumerate_dir(&dir, |_| n += 1).expect("enumerate");
        best_enum = best_enum.min(t.elapsed().as_secs_f64() * 1000.0);

        let t = Instant::now();
        let mut enc = BatchEncoder::with_capacity(64 * 1024);
        let mut total = 0usize;
        octo_core::enumerate_dir(&dir, |e| {
            enc.push(&e);
            if enc.len() >= 8192 {
                total += enc.finish(false).len();
            }
        })
        .expect("enumerate");
        total += enc.finish(true).len();
        best_encode = best_encode.min(t.elapsed().as_secs_f64() * 1000.0);
        count = n;
        bytes = total;
    }

    println!("{}", dir.display());
    println!("  entries:              {count}");
    println!("  enumerate only:       {best_enum:.2} ms (best of {RUNS}, warm cache)");
    println!("  enumerate + encode:   {best_encode:.2} ms -> {:.1} KB over IPC", bytes as f64 / 1024.0);
}
