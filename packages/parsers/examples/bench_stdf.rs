/// STDF parse pipeline benchmark.
///
/// Usage (requires both native and bench features):
///   cargo run --release --features native,bench --example bench_stdf -- file1.stdf file2.stdf ...
///
/// Reports a table with per-phase timings and serde serialisation cost.
///
/// Phases:
///   P1 iter  — RawDataIter loop + PTR/FTR fast-path accumulation (excluding HashMap)
///   P2 hmap  — to_test_values() HashMap construction across all PRR records
///   P3 serde — serde_json serialisation of the ParsedStdf result to a JSON string

#[cfg(not(feature = "bench"))]
fn main() {
    eprintln!("This example requires --features bench. Run:");
    eprintln!("  cargo run --release --features native,bench --example bench_stdf -- <files...>");
    std::process::exit(1);
}

#[cfg(feature = "bench")]
fn main() {
    let paths: Vec<String> = std::env::args().skip(1).collect();
    if paths.is_empty() {
        eprintln!("usage: bench_stdf <file.stdf> [file2.stdf ...]");
        std::process::exit(1);
    }

    println!(
        "{:<26}  {:>7}  {:>6}  {:>6}  {:>8}  {:>8}  {:>8}  {:>8}  {:>8}  {:>9}",
        "file", "MB", "dies", "tests", "P1_iter", "P2_hmap", "P1+P2", "P3_serde", "total", "PTR/s"
    );
    println!("{}", "-".repeat(110));

    for path in &paths {
        bench_file(path);
    }
}

#[cfg(feature = "bench")]
fn bench_file(path: &str) {
    use std::time::Instant;

    let stem = std::path::Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(path);
    // Truncate long names
    let label = if stem.len() > 26 { &stem[..26] } else { stem };

    // ── Read ──────────────────────────────────────────────────────────────────
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) => { eprintln!("error reading {path}: {e}"); return; }
    };
    let mb = bytes.len() as f64 / 1_048_576.0;

    // ── Parse with phase timing ───────────────────────────────────────────────
    let t_total = Instant::now();
    let (result, timing) = match testdata_parser::parse_stdf::parse_stdf_from_bytes_timed(&bytes) {
        Ok(r) => r,
        Err(e) => { eprintln!("parse error {path}: {e}"); return; }
    };
    let parse_ms = t_total.elapsed().as_millis();

    // ── Serde serialisation ───────────────────────────────────────────────────
    let t_serde = Instant::now();
    let json = serde_json::to_string(&result).unwrap();
    let p3_ms = t_serde.elapsed().as_millis();
    let json_mb = json.len() as f64 / 1_048_576.0;
    drop(json); // don't count drop in timing

    let total_ms = parse_ms + p3_ms;
    let ptr_records = timing.die_count * timing.test_count;
    let ptr_per_sec = if parse_ms > 0 {
        (ptr_records as f64 / parse_ms as f64 * 1000.0) as u64
    } else {
        0
    };

    println!(
        "{:<26}  {:>6.1}M  {:>6}  {:>6}  {:>7}ms  {:>7}ms  {:>7}ms  {:>7}ms  {:>7}ms  {:>8}/s",
        label, mb,
        timing.die_count,
        timing.test_count,
        timing.p1_iter_ms,
        timing.p2_hashmap_ms,
        timing.p1_iter_ms + timing.p2_hashmap_ms,
        p3_ms,
        total_ms,
        ptr_per_sec,
    );

    // Extra detail line
    println!(
        "  └ P2/total={:.0}%  serde_json={:.1}MB  P3/total={:.0}%",
        timing.p2_hashmap_ms as f64 / parse_ms.max(1) as f64 * 100.0,
        json_mb,
        p3_ms as f64 / total_ms.max(1) as f64 * 100.0,
    );
}
