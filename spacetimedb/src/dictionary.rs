use std::collections::HashMap;

// Read-only static data baked into the wasm binary's data segment.
// Both files are produced by build.rs from `wordlist.txt`.
//
//   WORDLIST            — original lex-sorted wordlist (one word per line).
//   WORDLIST_BY_LEN     — same words, sorted by length desc then lex asc.
//                         Used by `find_best_playable` so the first match is
//                         the longest playable word and we early-exit when
//                         remaining words are shorter than `min_len`.
//   LEX_OFFSETS_BYTES   — packed little-endian u32 array of line-start
//                         offsets into WORDLIST. Lets `is_valid_word` do a
//                         binary search without materialising a Vec at
//                         runtime (modules can't safely cache state in
//                         `static` cells across reducer invocations).
static WORDLIST: &str = include_str!("../wordlist.txt");
static WORDLIST_BY_LEN: &str = include_str!(concat!(env!("OUT_DIR"), "/wordlist_by_length.txt"));
static LEX_OFFSETS_BYTES: &[u8] =
    include_bytes!(concat!(env!("OUT_DIR"), "/wordlist_lex_offsets.bin"));

fn n_lex_words() -> usize {
    LEX_OFFSETS_BYTES.len() / 4
}

fn lex_word_at(idx: usize) -> &'static str {
    let i = idx * 4;
    let start = u32::from_le_bytes([
        LEX_OFFSETS_BYTES[i],
        LEX_OFFSETS_BYTES[i + 1],
        LEX_OFFSETS_BYTES[i + 2],
        LEX_OFFSETS_BYTES[i + 3],
    ]) as usize;
    let bytes = WORDLIST.as_bytes();
    let mut end = start;
    while end < bytes.len() && bytes[end] != b'\n' {
        end += 1;
    }
    &WORDLIST[start..end]
}

pub fn is_valid_word(word: &str) -> bool {
    let target = word.to_ascii_uppercase();
    if target.len() < 2 {
        return false;
    }
    if !target.chars().all(|c| c.is_ascii_uppercase()) {
        return false;
    }
    let n = n_lex_words();
    let mut lo = 0usize;
    let mut hi = n;
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        match lex_word_at(mid).cmp(target.as_str()) {
            std::cmp::Ordering::Less => lo = mid + 1,
            std::cmp::Ordering::Equal => return true,
            std::cmp::Ordering::Greater => hi = mid,
        }
    }
    false
}

// Find the longest word in the dictionary that can be spelled from `rack`.
// Returns None if no word of `min_len` or longer can be made.
//
// Iterates the by-length-descending wordlist; the first match is by
// definition the longest playable word, and we stop as soon as the next
// candidate is shorter than `min_len`.
pub fn find_best_playable(rack: &HashMap<char, u32>, min_len: usize) -> Option<String> {
    let mut rack_counts = [0u32; 26];
    let mut total: u32 = 0;
    for (&c, &n) in rack.iter() {
        if c.is_ascii_uppercase() {
            let slot = (c as u8 - b'A') as usize;
            rack_counts[slot] = rack_counts[slot].saturating_add(n);
            total = total.saturating_add(n);
        }
    }
    if (total as usize) < min_len {
        return None;
    }

    for word in WORDLIST_BY_LEN.lines() {
        if word.len() < min_len {
            break;
        }
        if word.len() as u32 > total {
            continue;
        }
        let mut need = [0u32; 26];
        let mut ok = true;
        for b in word.bytes() {
            if !b.is_ascii_uppercase() {
                ok = false;
                break;
            }
            need[(b - b'A') as usize] += 1;
        }
        if !ok {
            continue;
        }
        if need.iter().zip(rack_counts.iter()).all(|(n, h)| n <= h) {
            return Some(word.to_string());
        }
    }
    None
}
