use std::env;
use std::fs;
use std::path::Path;

fn main() {
    println!("cargo:rerun-if-changed=wordlist.txt");
    let src = fs::read_to_string("wordlist.txt").expect("wordlist.txt missing");

    let words: Vec<&str> = src.lines().filter(|l| !l.is_empty()).collect();

    let out_dir = env::var("OUT_DIR").expect("OUT_DIR not set");
    let out_dir = Path::new(&out_dir);

    let mut offsets: Vec<u32> = Vec::with_capacity(words.len());
    let mut cursor: u32 = 0;
    for w in &words {
        offsets.push(cursor);
        cursor += w.len() as u32 + 1; // include '\n'
    }
    let mut offsets_bytes = Vec::with_capacity(offsets.len() * 4);
    for o in &offsets {
        offsets_bytes.extend_from_slice(&o.to_le_bytes());
    }
    fs::write(out_dir.join("wordlist_lex_offsets.bin"), &offsets_bytes).unwrap();

    let mut by_len: Vec<&str> = words.clone();
    by_len.sort_by(|a, b| b.len().cmp(&a.len()).then(a.cmp(b)));
    fs::write(out_dir.join("wordlist_by_length.txt"), by_len.join("\n")).unwrap();
}
