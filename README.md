# Simple Music Player (SillyTavern extension)

Upload music files directly in the SillyTavern UI — no data-folder copy-paste.

## Install (manual)
1. Unzip this file.
2. Copy the `simple-music-player` folder into: `<SillyTavern>/data/<your-user>/extensions/`
3. Restart SillyTavern, open Extensions panel → "Simple Music Player".

## Features
- ➕ Add Music: click, pick mp3/ogg/wav files (multiple supported)
- Playlist: play, reorder (↑/↓), remove (✕)
- Controls: play/pause, stop, next, prev, shuffle, loop, volume
- Files persist in your browser (IndexedDB) across reloads
- Slash command for scripting:
  - `/music play | pause | stop | next | prev | shuffle | loop`
  - `/music 3` — play track #3

Tip: in a preset, you can have the model trigger a track change, e.g.
wrap a command in your chat: `[/music next]` via STscript.
