// Where every bot in a match stands: rank, rack, points and balance, with
// each freshly played word shown briefly under its player's score.
import { useRef } from "react";
import type { MatchParticipant, WordPlay } from "./module_bindings/types";
import type { BotNames } from "./data";
import {
  competitionRank,
  fmtTimestamp,
  rackTiles,
  type PublicRack,
} from "./util";
import { Rack, TileWord } from "./Tile";

// How long a freshly played word lingers under its player's score.
const WORD_FADE_MS = 4000;
// Words older than this by the server's clock were already history when the
// page loaded, so they don't get the fresh-word treatment.
const WORD_STALE_MS = 10000;

export function Standings({
  participants,
  racks,
  plays,
  botName,
  now,
  limit,
}: {
  // Highest score first.
  participants: MatchParticipant[];
  racks: Map<bigint, PublicRack>;
  plays: WordPlay[];
  botName: BotNames;
  now: number;
  // Show only this many places.
  limit?: number;
}) {
  const fresh = useFreshWords(plays, now);
  // Bots level on points share a rank, so a tie for first shows as a tie.
  const rankOf = competitionRank(participants, (p) => p.score);
  const topScore = participants[0]?.score;

  return (
    <ol className="standings">
      {participants.slice(0, limit).map((p) => {
        const word = fresh.get(p.botId);
        const leading = p.score === topScore && p.score > 0n;
        return (
          <li key={String(p.id)} className={leading ? "leading" : undefined}>
            <span className="st-rank">{rankOf(p)}</span>
            <div className="st-who">
              <span className="st-name">{botName(p.botId)}</span>
              <Rack {...rackTiles(racks, p.botId)} className="st-rack" />
            </div>
            <div className="st-score">
              <span className="st-points">{String(p.score)}</span>
              <span className="st-balance" title="Currency left to bid with">
                {String(p.balance)} bucks
              </span>
              {word && (
                // Keyed by play, so a new word starts its own fade.
                <span
                  key={String(word.id)}
                  className="st-word"
                  style={{ animationDuration: `${WORD_FADE_MS}ms` }}
                >
                  <TileWord word={word.word} />
                  <span className="st-word-points">
                    +{String(word.totalReward)}
                  </span>
                </span>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// Each bot's latest word, while it's still fresh. Freshness is timed from
// when this browser first saw the play rather than from `playedAt`, because
// the client's clock can drift from the server's by a second or more, which
// is most of the fade.
function useFreshWords(plays: WordPlay[], now: number) {
  const firstSeen = useRef(new Map<bigint, number>());
  const fresh = new Map<bigint, WordPlay>();
  for (const play of plays) {
    if (!firstSeen.current.has(play.id)) firstSeen.current.set(play.id, now);
    const age = now - firstSeen.current.get(play.id)!;
    const stale = now - fmtTimestamp(play.playedAt) > WORD_STALE_MS;
    const prev = fresh.get(play.botId);
    if (age < WORD_FADE_MS && !stale && (!prev || play.id > prev.id)) {
      fresh.set(play.botId, play);
    }
  }
  return fresh;
}
