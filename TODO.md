# TODO

Things we're aware of but haven't done yet.

## Game design

- [ ] **Hide `AuctionResult.top_bid` from bot clients.** Right now it's a
  field on the public `AuctionResult` table so anything that subscribes
  (including bots) sees both the winner's bid amount and what they paid.
  Standard Vickrey only needs `paid` to be public; revealing `top_bid`
  leaks each winner's true valuation and undermines truth-telling. Keep
  it visible to the spectator UI for drama ("Brutus bid 22, paid 11") but
  strip it from anything a bot can read. Options:
  - Split the table: keep a public `AuctionResult` with `winner_bot_id`
    and `paid` only; put `top_bid` in a separate table that's behind an
    admin-gated view (the UI uses an admin-ish identity).
  - Or just drop `top_bid` from the schema entirely and accept a less
    dramatic spectator UX.

## Security / robustness

- [ ] **Gate `auction_tick` and `lobby_timeout_tick` to the scheduler.**
  They're currently callable by any client, which would let someone
  trigger a premature lobby resolution or auction close. Fine for a
  hackathon, not for a real deployment.

- [ ] **Per-bot identity in `submit_bid` / `submit_word` is implicit.**
  Bots authenticate via their `BotCredential`. If a token leaks, the
  holder can do anything that bot can do. Token recovery means minting a
  new credential — the old one keeps working until you actively delete
  the row. We don't expose a "revoke credential" reducer yet.

## Polish

- [ ] **Match views could show the lobby that produced them** and link
  back. Right now there's no breadcrumb from `/matches/:id` back to the
  lobby it came from.

- [ ] **`top_bid` column on the spectator UI Recent Auctions table** —
  blocked on the bot-visibility fix above.
