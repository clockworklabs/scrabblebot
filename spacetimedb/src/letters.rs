pub fn letter_value(c: char) -> u32 {
    match c {
        'A' | 'E' | 'I' | 'O' | 'U' | 'L' | 'N' | 'S' | 'T' | 'R' => 1,
        'D' | 'G' => 2,
        'B' | 'C' | 'M' | 'P' => 3,
        'F' | 'H' | 'V' | 'W' | 'Y' => 4,
        'K' => 5,
        'J' | 'X' => 8,
        'Q' | 'Z' => 10,
        _ => 0,
    }
}

// Standard Scrabble distribution, no blanks. 98 tiles total.
pub const DEFAULT_BAG: &[(char, u32)] = &[
    ('A', 9),
    ('B', 2),
    ('C', 2),
    ('D', 4),
    ('E', 12),
    ('F', 2),
    ('G', 3),
    ('H', 2),
    ('I', 9),
    ('J', 1),
    ('K', 1),
    ('L', 4),
    ('M', 2),
    ('N', 6),
    ('O', 8),
    ('P', 2),
    ('Q', 1),
    ('R', 6),
    ('S', 4),
    ('T', 6),
    ('U', 4),
    ('V', 2),
    ('W', 2),
    ('X', 1),
    ('Y', 2),
    ('Z', 1),
];

// Length-based reward multiplier as (numerator, denominator).
// total_reward = base_score * num / denom (integer division).
// Hoarding letters for longer words pays off superlinearly.
pub fn length_multiplier(len: usize) -> (i64, i64) {
    match len {
        0..=3 => (1, 1), // 1.0x
        4 => (3, 2),     // 1.5x
        5 => (2, 1),     // 2.0x
        6 => (5, 2),     // 2.5x
        _ => (3, 1),     // 3.0x for 7+
    }
}
