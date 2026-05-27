use std::collections::HashMap;
use std::sync::OnceLock;

// Embedded ENABLE1 wordlist (public domain) — sorted, uppercase, one word per line.
static WORDLIST: &str = include_str!("../wordlist.txt");
static LINES: OnceLock<Vec<&'static str>> = OnceLock::new();

fn lines() -> &'static [&'static str] {
    LINES.get_or_init(|| WORDLIST.lines().collect())
}

pub fn is_valid_word(word: &str) -> bool {
    let target = word.to_ascii_uppercase();
    if target.len() < 2 {
        return false;
    }
    if !target.chars().all(|c| c.is_ascii_uppercase()) {
        return false;
    }
    lines().binary_search(&target.as_str()).is_ok()
}

// Find the longest word in the dictionary that can be spelled from `rack`.
// Returns None if no word of `min_len` or longer can be made.
pub fn find_best_playable(rack: &HashMap<char, u32>, min_len: usize) -> Option<String> {
    let total: u32 = rack.values().sum();
    if (total as usize) < min_len {
        return None;
    }
    let mut best: Option<&'static str> = None;
    for &word in lines() {
        if word.len() < min_len {
            continue;
        }
        if let Some(b) = best {
            if word.len() <= b.len() {
                continue;
            }
        }
        if word.len() as u32 > total {
            continue;
        }
        // Tally required letters and check the rack covers it.
        let mut need: HashMap<char, u32> = HashMap::new();
        for c in word.chars() {
            *need.entry(c).or_insert(0) += 1;
        }
        if need
            .iter()
            .all(|(c, n)| rack.get(c).copied().unwrap_or(0) >= *n)
        {
            best = Some(word);
        }
    }
    best.map(String::from)
}
