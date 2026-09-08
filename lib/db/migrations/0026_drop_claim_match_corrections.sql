-- The anchor flow's answers, and the flow itself, are gone.
--
-- A claim is now one chain of parts on the identity map, written by the person
-- on the claim page. `claim_match_corrections` stored the other model: which
-- track someone picked at a sampled moment, from which an identity and its
-- frame ranges had to be re-derived on every single read. Nothing writes it,
-- nothing reads it, and every statistic now comes from the chain.
--
-- This is not reversible. Claims made through the old flow are not migrated:
-- an anchor answer is a vote at a point in time, not a stretch of frames, and
-- anything reconstructed from one would be a guess presented as a person's own
-- account of where they were.

DROP TABLE IF EXISTS "claim_match_corrections";
