-- Closes half of the tracked hotel room-type limitation
-- (docs/IMPLEMENTATION_PLAN.md §5): nothing checked whether a hotel actually
-- had enough rooms free to book one per room group. Scoped deliberately to
-- availability count only, not full room-type variety (a hotel row still
-- models one bookable room type at one rate) -- the user chose this over a
-- full room-type catalog as the smaller, still-useful half of the gap.
--
-- Default of 5 for every existing seed hotel is deliberately generous: this
-- project's room-group counts are always small (a handful of rooms per
-- party at most), so no existing flow is affected by this backfill -- the
-- new roomAvailabilityConstraint is exercised by synthetic unit tests, the
-- same way the activity-retrieval overfetch fix's retry logic was, since
-- real seed data can't reach a genuinely sold-out hotel either way.

alter table hotels add column available_rooms int not null default 5;
