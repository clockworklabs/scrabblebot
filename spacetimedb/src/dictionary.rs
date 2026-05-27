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
