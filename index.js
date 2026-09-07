/**
 * Simple Music Player for SillyTavern
 * Upload audio files directly from the extensions panel — no data-folder wrangling.
 * Files are stored in your browser's IndexedDB, so they survive page reloads.
 *
 * Features:
 *  - "Add Music" button accepts mp3/ogg/wav/anything audio/*, multiple at once
 *  - Playlist with play / reorder / remove
 *  - Play, pause, stop, next, prev, shuffle, loop, volume
 *  - Slash command: /music play | pause | stop | next | prev | shuffle | loop | <track number>
 */

import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';

const MODULE_NAME = 'simple-music-player';
const LOG_PREFIX = '[Simple Music]';

const defaultSettings = {
    volume: 0.5,
    loop: false,
    shuffle: false,
    order: [], // array of track ids, playback sequence
};

const log = (...args) => console.log(LOG_PREFIX, ...args);

function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function settings() {
    if (!extension_settings[MODULE_NAME]) extension_settings[MODULE_NAME] = structuredClone(defaultSettings);
    for (const k of Object.keys(defaultSettings)) {
        if (extension_settings[MODULE_NAME][k] === undefined) extension_settings[MODULE_NAME][k] = defaultSettings[k];
    }
    return extension_settings[MODULE_NAME];
}

// ---------- IndexedDB persistence ----------

function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open('st_simple_music', 1);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('tracks')) db.createObjectStore('tracks', { keyPath: 'id' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function dbOp(mode, fn) {
    return openDB().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction('tracks', mode);
        const req = fn(tx.objectStore('tracks'));
        tx.oncomplete = () => resolve(req ? req.result : undefined);
        tx.onerror = () => reject(tx.error);
    }));
}

// ---------- State ----------

const trackCache = new Map(); // id -> { id, name, type, blob }
let audio = null;
let objectUrl = null;
let currentId = null;

// ---------- Audio engine ----------

function ensureAudio() {
    if (audio) return audio;
    audio = new Audio();
    audio.volume = settings().volume;
    audio.addEventListener('ended', onTrackEnd);
    audio.addEventListener('play', renderPlaylist);
    audio.addEventListener('pause', renderPlaylist);
    return audio;
}

function onTrackEnd() {
    if (settings().loop) {
        playId(currentId);
        return;
    }
    nextTrack();
}

function orderedIds() {
    const s = settings();
    for (const id of trackCache.keys()) {
        if (!s.order.includes(id)) s.order.push(id);
    }
    s.order = s.order.filter(id => trackCache.has(id));
    return s.order;
}

function pickNext(prev) {
    const ids = orderedIds();
    if (!ids.length) return null;
    if (settings().shuffle && ids.length > 1) {
        let pick = prev;
        while (pick === prev) pick = ids[Math.floor(Math.random() * ids.length)];
        return pick;
    }
    const i = ids.indexOf(prev);
    if (i === -1 || i === ids.length - 1) return ids[0];
    return ids[i + 1];
}

function pickPrev(cur) {
    const ids = orderedIds();
    if (!ids.length) return null;
    const i = ids.indexOf(cur);
    if (i <= 0) return ids[ids.length - 1];
    return ids[i - 1];
}

function playId(id) {
    const t = trackCache.get(id);
    if (!t) return false;
    const a = ensureAudio();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(t.blob);
    a.src = objectUrl;
    a.play().catch(err => log('play blocked:', err && err.message));
    currentId = id;
    renderPlaylist();
    return true;
}

function toggleTrack(id) {
    if (audio && id === currentId) {
        if (audio.paused) {
            audio.play().catch(err => log('play blocked:', err && err.message));
        } else {
            audio.pause();
        }
        renderPlaylist();
        return;
    }
    playId(id);
}

function playCurrent() {
    if (currentId && trackCache.has(currentId)) {
        const a = ensureAudio();
        if (a.paused) a.play().catch(err => log('play blocked:', err && err.message));
        renderPlaylist();
        return;
    }
    const ids = orderedIds();
    if (!ids.length) return;
    playId(settings().shuffle ? ids[Math.floor(Math.random() * ids.length)] : ids[0]);
}

function pausePlayback() {
    if (audio) audio.pause();
    renderPlaylist();
}

function stopPlayback() {
    if (audio) {
        audio.pause();
        audio.currentTime = 0;
    }
    currentId = null;
    renderPlaylist();
}

function nextTrack() {
    const n = pickNext(currentId);
    if (n) playId(n);
}

function prevTrack() {
    const p = pickPrev(currentId);
    if (p) playId(p);
}

// ---------- Track management ----------

async function addFiles(fileList) {
    const added = [];
    for (const file of fileList) {
        if (!file || (file.type && !file.type.startsWith('audio/'))) {
            log('skipped non-audio file:', file && file.name);
            continue;
        }
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        const track = { id, name: file.name, type: file.type || 'audio', blob: file };
        await dbOp('readwrite', st => st.put(track));
        trackCache.set(id, track);
        settings().order.push(id);
        added.push(id);
    }
    if (added.length) {
        saveSettingsDebounced();
        renderPlaylist();
    }
    return added;
}

async function removeTrack(id) {
    trackCache.delete(id);
    settings().order = settings().order.filter(x => x !== id);
    await dbOp('readwrite', st => st.delete(id)).catch(() => {});
    if (currentId === id) {
        stopPlayback();
        currentId = null;
    }
    saveSettingsDebounced();
    renderPlaylist();
}

function moveTrack(id, dir) {
    const order = settings().order;
    const i = order.indexOf(id);
    const j = i + dir;
    if (i === -1 || j < 0 || j >= order.length) return;
    const tmp = order[i];
    order[i] = order[j];
    order[j] = tmp;
    saveSettingsDebounced();
    renderPlaylist();
}

// ---------- UI ----------

function injectUI() {
    if (document.getElementById('sm-root')) {
        renderPlaylist();
        return true;
    }
    const host = document.getElementById('extensions_settings2');
    if (!host) return false;

    const root = document.createElement('div');
    root.id = 'sm-root';
    root.innerHTML = `
        <div class="inline-drawer" style="margin-bottom: 1em;">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>🎵 Simple Music Player</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div id="sm-now" class="muted" style="margin: 0.5em 0;">Nothing playing</div>
                <div style="display: flex; flex-wrap: wrap; gap: 6px; margin: 0.25em 0;">
                    <button id="sm-prev" class="menu_button" title="Previous">⏮</button>
                    <button id="sm-play-pause" class="menu_button" title="Play / Pause">▶</button>
                    <button id="sm-next" class="menu_button" title="Next">⏭</button>
                    <button id="sm-stop" class="menu_button" title="Stop">⏹</button>
                    <label class="menu_button" title="Add music files" style="cursor: pointer;">
                        ➕ Add Music
                        <input id="sm-file-input" type="file" accept="audio/*" multiple hidden>
                    </label>
                </div>
                <div style="display: flex; align-items: center; gap: 6px; margin: 0.25em 0;">
                    <span>🔊</span>
                    <input id="sm-volume" type="range" min="0" max="100" style="flex: 1;">
                </div>
                <div style="display: flex; gap: 12px; margin: 0.25em 0;">
                    <label style="display: flex; gap: 4px; align-items: center;"><input id="sm-shuffle" type="checkbox"> Shuffle</label>
                    <label style="display: flex; gap: 4px; align-items: center;"><input id="sm-loop" type="checkbox"> Loop</label>
                </div>
                <div id="sm-playlist"></div>
            </div>
        </div>`;

    host.appendChild(root);
    wireUI(root);
    renderPlaylist();
    return true;
}

function wireUI(root) {
    const q = sel => root.querySelector(sel);

    const fileInput = q('#sm-file-input');
    if (fileInput) {
        fileInput.addEventListener('change', e => {
            if (e.target && e.target.files && e.target.files.length) {
                addFiles(Array.from(e.target.files));
            }
            e.target.value = '';
        });
    }

    const playPause = q('#sm-play-pause');
    if (playPause) playPause.addEventListener('click', () => {
        if (audio && !audio.paused) pausePlayback();
        else playCurrent();
    });

    const next = q('#sm-next');
    if (next) next.addEventListener('click', nextTrack);

    const prev = q('#sm-prev');
    if (prev) prev.addEventListener('click', prevTrack);

    const stop = q('#sm-stop');
    if (stop) stop.addEventListener('click', stopPlayback);

    const volume = q('#sm-volume');
    if (volume) {
        volume.value = String(Math.round(settings().volume * 100));
        volume.addEventListener('input', e => {
            settings().volume = Math.max(0, Math.min(1, (Number(e.target.value) || 0) / 100));
            if (audio) audio.volume = settings().volume;
            saveSettingsDebounced();
        });
    }

    const shuffle = q('#sm-shuffle');
    if (shuffle) {
        shuffle.checked = !!settings().shuffle;
        shuffle.addEventListener('change', e => {
            settings().shuffle = !!e.target.checked;
            saveSettingsDebounced();
        });
    }

    const loop = q('#sm-loop');
    if (loop) {
        loop.checked = !!settings().loop;
        loop.addEventListener('change', e => {
            settings().loop = !!e.target.checked;
            saveSettingsDebounced();
        });
    }

    const playlist = q('#sm-playlist');
    if (playlist) {
        playlist.addEventListener('click', e => {
            const btn = e.target.closest ? e.target.closest('[data-sm-action]') : null;
            if (!btn) return;
            const id = btn.getAttribute('data-sm-id');
            const action = btn.getAttribute('data-sm-action');
            if (action === 'play') toggleTrack(id);
            else if (action === 'remove') removeTrack(id);
            else if (action === 'up') moveTrack(id, -1);
            else if (action === 'down') moveTrack(id, 1);
        });
    }
}

function renderPlaylist() {
    const list = document.getElementById('sm-playlist');
    if (list) {
        const ids = orderedIds();
        if (!ids.length) {
            list.innerHTML = '<div class="muted" style="margin: 0.5em 0;">No tracks yet — hit "Add Music".</div>';
        } else {
            list.innerHTML = ids.map((id, i) => {
                const t = trackCache.get(id);
                const active = id === currentId && audio && !audio.paused;
                const pausedHere = id === currentId && audio && audio.paused;
                return `
                    <div style="display: flex; align-items: center; gap: 6px; padding: 2px 0;">
                        <span class="muted" style="min-width: 1.4em;">${i + 1}.</span>
                        <span style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;${active ? ' font-weight: bold;' : ''}">${esc(t.name)}</span>
                        <button class="menu_button" data-sm-action="play" data-sm-id="${esc(id)}" title="${active ? 'Pause' : (pausedHere ? 'Resume' : 'Play')}" style="padding: 0 6px;">${active ? '⏸' : (pausedHere ? '▶' : '▶')}</button>
                        <button class="menu_button" data-sm-action="up" data-sm-id="${esc(id)}" title="Move up" style="padding: 0 6px;">↑</button>
                        <button class="menu_button" data-sm-action="down" data-sm-id="${esc(id)}" title="Move down" style="padding: 0 6px;">↓</button>
                        <button class="menu_button" data-sm-action="remove" data-sm-id="${esc(id)}" title="Remove" style="padding: 0 6px;">✕</button>
                    </div>`;
            }).join('');
        }
    }

    const now = document.getElementById('sm-now');
    if (now) {
        if (currentId && trackCache.has(currentId)) {
            const label = audio && !audio.paused ? 'Now playing: ' : 'Paused: ';
            now.textContent = label + trackCache.get(currentId).name;
        } else {
            now.textContent = 'Nothing playing';
        }
    }

    const pp = document.getElementById('sm-play-pause');
    if (pp) pp.textContent = (audio && !audio.paused) ? '⏸' : '▶';
}

// ---------- Slash command ----------

function registerSlashCommand() {
    if (typeof window.SlashCommandParser === 'undefined' || !window.SlashCommandParser || !window.SlashCommandParser.addCommandObject || !window.SlashCommand) {
        log('SlashCommandParser not available; /music command skipped.');
        return;
    }
    try {
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'music',
            callback: (_args, value) => {
                const sub = String(value || '').trim().toLowerCase();
                if (sub === 'play') playCurrent();
                else if (sub === 'pause') pausePlayback();
                else if (sub === 'stop') stopPlayback();
                else if (sub === 'next') nextTrack();
                else if (sub === 'prev') prevTrack();
                else if (sub === 'shuffle') { settings().shuffle = !settings().shuffle; saveSettingsDebounced(); }
                else if (sub === 'loop') { settings().loop = !settings().loop; saveSettingsDebounced(); }
                else if (/^\d+$/.test(sub)) {
                    const ids = orderedIds();
                    const idx = parseInt(sub, 10) - 1;
                    if (ids[idx]) playId(ids[idx]);
                }
                renderPlaylist();
                return '';
            },
            unnamedArgumentList: [{
                description: 'play | pause | stop | next | prev | shuffle | loop | track number',
                defaultValue: '',
                isRequired: false,
            }],
            help: 'Control the Simple Music Player.',
        }));
        log('/music slash command registered.');
    } catch (err) {
        log('failed to register /music:', err && err.message);
    }
}

// ---------- Init ----------

jQuery(async () => {
    settings();
    try {
        const all = await dbOp('readonly', st => st.getAll());
        if (Array.isArray(all)) {
            for (const t of all) trackCache.set(t.id, t);
        }
    } catch (err) {
        log('IndexedDB unavailable; uploads will not persist across reloads:', err && err.message);
    }

    let tries = 0;
    const timer = setInterval(() => {
        tries += 1;
        if (injectUI() || tries > 40) clearInterval(timer);
    }, 500);

    registerSlashCommand();
    log(`loaded — ${trackCache.size} track(s) in library.`);
});

// Test hooks (harmless in production; used by automated smoke tests)
window.__sm = {
    addFiles,
    playId,
    toggleTrack,
    nextTrack,
    prevTrack,
    removeTrack,
    getState: () => ({
        cacheSize: trackCache.size,
        order: orderedIds(),
        currentId,
        isPlaying: !!(audio && !audio.paused),
        volume: settings().volume,
    }),
};
