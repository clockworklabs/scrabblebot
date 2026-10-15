// Pure functions: tile values, the bag, scoring multipliers, the
// dictionary and the sim bots' bidding rules.

use std::collections::HashMap;

use crate::{BotStrategy, decide_bid, dictionary, letters};

fn rack_of(letters: &str) -> HashMap<char, u32> {
    let mut rack = HashMap::new();
    for c in letters.chars() {
        *rack.entry(c).or_insert(0) += 1;
    }
    rack
}

#[test]
fn letter_values_follow_scrabble() {
    let cases = [
        ('A', 1),
        ('D', 2),
        ('B', 3),
        ('F', 4),
        ('K', 5),
        ('J', 8),
        ('Q', 10),
        ('Z', 10),
    ];
    for (c, v) in cases {
        assert_eq!(letters::letter_value(c), v, "{c}");
    }
    assert_eq!(letters::letter_value('a'), 0, "lowercase is not a tile");
    assert_eq!(letters::letter_value('?'), 0);
}

#[test]
fn default_bag_is_the_98_tile_scrabble_set() {
    assert_eq!(letters::DEFAULT_BAG.len(), 26);
    assert_eq!(letters::DEFAULT_BAG.iter().map(|(_, n)| n).sum::<u32>(), 98);
    let points: u32 = letters::DEFAULT_BAG
        .iter()
        .map(|(c, n)| letters::letter_value(*c) * n)
        .sum();
    assert_eq!(points, 187, "standard Scrabble face value without blanks");
}

#[test]
fn length_multiplier_rewards_longer_words() {
    assert_eq!(letters::length_multiplier(2), (1, 1));
    assert_eq!(letters::length_multiplier(3), (1, 1));
    assert_eq!(letters::length_multiplier(4), (3, 2));
    assert_eq!(letters::length_multiplier(5), (2, 1));
    assert_eq!(letters::length_multiplier(6), (5, 2));
    assert_eq!(letters::length_multiplier(7), (3, 1));
    assert_eq!(letters::length_multiplier(15), (3, 1));
}

#[test]
fn dictionary_accepts_words_in_any_case() {
    assert!(dictionary::is_valid_word("AA"));
    assert!(dictionary::is_valid_word("cat"));
    assert!(dictionary::is_valid_word("QUIZ"));
    // First and last entries exercise the binary search's bounds.
    let first = include_str!("../../wordlist.txt").lines().next().unwrap();
    let last = include_str!("../../wordlist.txt").lines().last().unwrap();
    assert!(dictionary::is_valid_word(first));
    assert!(dictionary::is_valid_word(last));
}

#[test]
fn dictionary_rejects_nonwords_and_junk() {
    assert!(!dictionary::is_valid_word("XQZT"));
    assert!(
        !dictionary::is_valid_word("A"),
        "single letters are too short"
    );
    assert!(!dictionary::is_valid_word(""));
    assert!(!dictionary::is_valid_word("CA T"));
    assert!(!dictionary::is_valid_word("CAT1"));
    assert!(!dictionary::is_valid_word("CAFÉ"));
}

#[test]
fn wordlist_is_sorted_uppercase_and_unique() {
    // `is_valid_word` binary-searches the raw file, so this must hold.
    let words: Vec<&str> = include_str!("../../wordlist.txt")
        .lines()
        .filter(|l| !l.is_empty())
        .collect();
    for pair in words.windows(2) {
        assert!(
            pair[0] < pair[1],
            "out of order: {} >= {}",
            pair[0],
            pair[1]
        );
    }
    for w in &words {
        assert!(w.bytes().all(|b| b.is_ascii_uppercase()), "bad entry {w:?}");
    }
}

#[test]
fn find_best_playable_picks_a_longest_word() {
    let word = dictionary::find_best_playable(&rack_of("TAC"), 3).unwrap();
    assert_eq!(word.len(), 3);
    assert!(["ACT", "CAT"].contains(&word.as_str()), "{word}");

    let word = dictionary::find_best_playable(&rack_of("SETAERX"), 3).unwrap();
    assert!(dictionary::is_valid_word(&word));
    assert!(
        word.len() >= 6,
        "expected a long word from SETAERX, got {word}"
    );
    let mut rack = rack_of("SETAERX");
    for c in word.chars() {
        let n = rack.get_mut(&c).expect("used a letter not on the rack");
        assert!(*n > 0, "used {c} too many times");
        *n -= 1;
    }
}

#[test]
fn find_best_playable_respects_min_len() {
    assert_eq!(dictionary::find_best_playable(&rack_of("AA"), 3), None);
    assert_eq!(
        dictionary::find_best_playable(&rack_of("AA"), 2),
        Some("AA".into())
    );
    assert_eq!(dictionary::find_best_playable(&rack_of("QXZ"), 3), None);
    assert_eq!(dictionary::find_best_playable(&HashMap::new(), 2), None);
}

#[test]
fn find_best_playable_ignores_non_tiles() {
    let mut rack = rack_of("CAT");
    rack.insert('a', 5);
    rack.insert('?', 5);
    let word = dictionary::find_best_playable(&rack, 3).unwrap();
    assert_eq!(word.len(), 3);
}

#[test]
fn sim_bid_strategies() {
    // E is worth 1, Q 10.
    assert_eq!(decide_bid(&BotStrategy::Human, "Q", 100), 0);
    assert_eq!(
        decide_bid(&BotStrategy::Cheapskate, "E", 100),
        1,
        "never below 1"
    );
    assert_eq!(decide_bid(&BotStrategy::Cheapskate, "Q", 100), 9);
    assert_eq!(decide_bid(&BotStrategy::ValueBidder, "Q", 100), 10);
    assert_eq!(
        decide_bid(&BotStrategy::Aggressive, "E", 100),
        5,
        "vowel premium"
    );
    assert_eq!(decide_bid(&BotStrategy::Aggressive, "Q", 100), 12);
}

#[test]
fn sim_bids_are_capped_by_balance() {
    assert_eq!(decide_bid(&BotStrategy::Aggressive, "Q", 7), 7);
    assert_eq!(decide_bid(&BotStrategy::ValueBidder, "Q", 0), 0);
    assert_eq!(
        decide_bid(&BotStrategy::ValueBidder, "Q", -5),
        0,
        "never negative"
    );
}
