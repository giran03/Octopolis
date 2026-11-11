//! Times index build and query latency on a real folder tree.
//!
//!     cargo run --release -p octo-core --example bench_search -- C:\Windows "kernel ext:dll"

use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::time::Instant;

use octo_core::ops::CancelToken;
use octo_core::search::{self, query, rank};

fn main() {
    let mut args = std::env::args().skip(1);
    let root = PathBuf::from(args.next().unwrap_or_else(|| r"C:\Windows".into()));
    let text = args.next().unwrap_or_else(|| "kernel ext:dll".into());

    let t = Instant::now();
    let scanned = AtomicU64::new(0);
    let (index, mode) = search::build_index(&root, &CancelToken::default(), &scanned).expect("index");
    let build_ms = t.elapsed().as_secs_f64() * 1000.0;

    let q = query::parse(&text).expect("query");
    let mut best = f64::MAX;
    let mut result = None;
    for _ in 0..5 {
        let t = Instant::now();
        let r = rank::run(&index, &q, 5000, &CancelToken::default());
        best = best.min(t.elapsed().as_secs_f64() * 1000.0);
        result = Some(r);
    }
    let r = result.unwrap();

    println!("{} ({mode:?})", root.display());
    println!("  indexed:   {} items in {build_ms:.0} ms ({} unreadable folders)", index.len(), index.unreadable);
    println!("  query:     {text:?} -> {} matches in {best:.2} ms (best of 5)", r.matched);
    for h in r.hits.iter().take(3) {
        println!("    {:>5}  {}", h.score, index.rel_path(h.index));
    }
}
