// Playing words: validation, rack consumption and scoring.

use super::*;

/// Ann (a real bot) in a running match with a sim. Returns (match, ann).
fn setup(ctx: &TestContext, letters: &str) -> (u64, u64) {
    let ann = team_with_bot(ctx, "alice", "Ann");
    let m = start_match(ctx, AuctionType::Vickrey, &[ann, sim_ids(ctx)[0]]);
    set_rack(ctx, m, ann, letters);
    (m, ann)
}

fn play(ctx: &TestContext, match_id: u64, word: &str) -> Result<(), String> {
    let word = word.to_string();
    call(ctx, "Ann", move |tx| submit_word(tx, match_id, word))
}

#[test]
fn playing_a_word_scores_it_and_uses_up_the_tiles() {
    let ctx = new_db();
    let (m, ann) = setup(&ctx, "CATT");

    play(&ctx, m, "cat").unwrap();

    assert_eq!(rack(&ctx, m, ann), vec![("T".into(), 1)]);
    let p = participant(&ctx, m, ann);
    assert_eq!((p.score, p.balance), (5, STARTING_BALANCE + 5));
    let w = ctx.db.word_play().play_by_bot().filter(ann).next().unwrap();
    assert_eq!(w.word, "CAT");
    assert_eq!((w.base_score, w.bonus, w.total_reward), (5, 0, 5));
    assert_eq!(w.played_at, now());
}

#[test]
fn longer_words_earn_a_multiplier() {
    // (word, base, total)
    let cases = [
        ("QUIZ", 22, 33),    // 1.5x
        ("AXES", 11, 16),    // 1.5x, rounded down
        ("QUAKE", 18, 36),   // 2x
        ("ZEBRAS", 17, 42),  // 2.5x, rounded down
        ("JUKEBOX", 27, 81), // 3x
    ];
    for (word, base, total) in cases {
        let ctx = new_db();
        let (m, ann) = setup(&ctx, word);
        play(&ctx, m, word).unwrap();
        let w = ctx.db.word_play().play_by_bot().filter(ann).next().unwrap();
        assert_eq!(
            (w.base_score, w.total_reward, w.bonus),
            (base, total, total - base),
            "{word}"
        );
        assert_eq!(participant(&ctx, m, ann).score, total);
    }
}

#[test]
fn scores_accumulate_across_words() {
    let ctx = new_db();
    let (m, ann) = setup(&ctx, "CATDOG");
    play(&ctx, m, "CAT").unwrap();
    play(&ctx, m, "DOG").unwrap();
    assert_eq!(participant(&ctx, m, ann).score, 5 + 5);
    assert!(rack(&ctx, m, ann).is_empty());
}

#[test]
fn words_must_be_spelled_from_the_rack() {
    let ctx = new_db();
    let (m, ann) = setup(&ctx, "CAT");
    // Which letter is reported first depends on HashMap order.
    for word in ["DOG", "TACT", "CATS"] {
        let err = play(&ctx, m, word).unwrap_err();
        assert!(err.starts_with("Not enough '"), "{word}: {err}");
    }
    assert_eq!(
        play(&ctx, m, "TAT"),
        Err("Not enough 'T': need 2, have 1".into())
    );
    assert_eq!(
        rack(&ctx, m, ann).len(),
        3,
        "failed plays don't consume tiles"
    );
    assert_eq!(participant(&ctx, m, ann).score, 0);
}

#[test]
fn words_are_validated() {
    let ctx = new_db();
    let (m, _) = setup(&ctx, "CATXQZ");
    assert_eq!(
        play(&ctx, m, "C"),
        Err("Word must be at least 2 letters".into())
    );
    assert_eq!(play(&ctx, m, "CA T"), Err("Word must be A-Z only".into()));
    assert_eq!(play(&ctx, m, "çat"), Err("Word must be A-Z only".into()));
    assert_eq!(
        play(&ctx, m, "xqz"),
        Err("'XQZ' is not in the dictionary".into())
    );
    assert_eq!(play(&ctx, 9999, "CAT"), Err("Unknown match".into()));
    assert_eq!(ctx.db.word_play().count(), 0);
}

#[test]
fn only_participants_can_play() {
    let ctx = new_db();
    let (m, _) = setup(&ctx, "CAT");
    team_with_bot(&ctx, "bob", "Ben");
    let cat = |who: &str| call(&ctx, who, |tx| submit_word(tx, m, "CAT".into()));
    assert_eq!(
        cat("stranger"),
        Err("Your identity is not a credential for any bot".into())
    );
    assert_eq!(cat("Ben"), Err("Not in this match".into()));
}

#[test]
fn no_words_after_the_match_ends() {
    let ctx = new_db();
    let (m, ann) = setup(&ctx, "");
    run_to_end(&ctx, m);
    set_rack(&ctx, m, ann, "CAT");
    assert_eq!(play(&ctx, m, "CAT"), Err("Match not running".into()));
}

#[test]
fn racks_are_per_match() {
    let ctx = new_db();
    let ann = team_with_bot(&ctx, "alice", "Ann");
    let sims = sim_ids(&ctx);
    let m1 = start_match(&ctx, AuctionType::Vickrey, &[ann, sims[0]]);
    let m2 = start_match(&ctx, AuctionType::Vickrey, &[ann, sims[1]]);
    set_rack(&ctx, m1, ann, "CAT");
    set_rack(&ctx, m2, ann, "DOG");

    assert!(play(&ctx, m2, "CAT").unwrap_err().starts_with("Not enough"));
    play(&ctx, m1, "CAT").unwrap();
    assert_eq!(rack(&ctx, m2, ann).len(), 3);
}
