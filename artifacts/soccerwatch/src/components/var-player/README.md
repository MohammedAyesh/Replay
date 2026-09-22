# VarPlayer

`VarPlayer` is the only VAR player in the frontend. The owner VAR screen and
the admin VAR tab both render it.

It owns the shared VAR review behavior: HLS/DVR playback, program-date-time
wall clock, marks, keyboard and touch review controls, quality selection, and
camera retry/stale-feed states. It is built on `components/HlsPlayer.tsx`.