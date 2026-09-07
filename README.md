# Simple Music Player for SillyTavern

Upload audio files directly from the extensions panel — no data-folder wrangling.
Files are stored in your browser's IndexedDB, so they survive page reloads.

## Features
- "Add Music" button accepts mp3/ogg/wav/anything audio/*, multiple at once
- Playlist with play / reorder / remove
- Play, pause, stop, next, prev, shuffle, loop, volume
- Slash command: /music play | pause | stop | next | prev | shuffle | loop | <track number>

## Autoplay unlock (v1.1.0)
Browsers block programmatic audio until a human has interacted with the page.
This extension now ships with a built-in ~0.6s inaudible static sample (embedded
as a data-URI, no external file). On your first click or keypress anywhere in
SillyTavern, it silently plays once — which unlocks audio for the whole session.

After that, /music commands fired by the AI (via your preset's BGM triggers)
work with no human touch. If a play command arrives while still locked, it is
queued and fires automatically right after the unlock. The extensions panel
shows the current lock state (see the "Autoplay" status line).

## Install (Extension Installer)
Point SillyTavern's Extension Installer at this repo, or clone into:
`SillyTavern/data/<user>/extensions/simple-music-player/`
