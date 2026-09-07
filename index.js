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

// ---------- Autoplay unlock ("browser trick") ----------
// Browsers block programmatic audio until a user has interacted with the page.
// On the first click/keypress anywhere, we play a built-in ~0.6s inaudible
// static sample (amplitude 2/32767). That single "play during a user gesture"
// unlocks audio for the whole session, so later /music slash commands fired
// by the AI work without any human touch. No external file needed.

const UNLOCK_WAV = 'data:audio/wav;base64,UklGRqQlAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YYAlAAD+//7/AAD////////+/wIA/v8CAAEA/v/+//7//////wIAAgD+/wIA//8CAAEA//8BAAIAAAD+////AQAAAAAA/////wAA/v/+/wEA/v8AAAAAAgAAAP7/AQACAP7/AQD+/wIAAAACAAAAAgD///7//v///wAA/v////7/AQAAAAEAAAD//wAAAAD//wAA/v8CAP//AgD/////AQABAAAAAgD//wAA/v////7/AAABAAAA/v///wIAAAD//wEAAQABAP//AAD/////AgACAAAAAgABAAIAAQAAAP////8CAAEA/v/+//7//////wEAAgD+/wEAAQACAAEAAgAAAAIA/v/+/wIAAAAAAP7/AAABAP//AQD+/wAAAgD//wIA/v8AAAIAAgD/////AAD//wIAAgD+/wIAAAABAP7//v8AAAAA///+////AgD+//7/AQD+/wIA/////wEAAgD//wAAAgACAAEA//8CAP//AAABAAAAAQACAAEA/v///////v8AAP7/AgACAP//AgD///7//v/+/////v/+/wAA/v8CAP//AAABAP//AgD//wIAAgABAP//AQABAP///v/+/wEAAAABAAEAAQD+//7//v8BAAAA/v////////8CAAEA//8BAP//AAABAP///v8BAAIA/v/+/wIA/v/+//////8BAAEAAQD//wEA/v///wEA/v8BAAAAAQAAAAEAAgABAP////8AAP///v8CAAIA/v8AAP7//v8CAAEAAgACAP///v8CAP7////+/wIA/v///wEA/v8CAP//AgACAP7/AgD+/wEAAgACAAIAAAAAAP//AAD//wAAAQD//wAAAQAAAP7//v8BAAIAAgD+//7/AgD//wIAAAD//wAA/v///wAAAAD//wEAAgAAAAIAAgD+/wIAAAD+////AAD+//7/AgD//wAAAAACAP//AAD//wAAAgABAAAA/v/+/wEAAAD+//7/AAD//wAA//8BAAIAAQACAP7//v/+////AgD+/wAAAgACAP//AQD///7/AAAAAP7/AAD//////v8AAAIAAQACAP//////////AQD+////AAABAP//AAD///7/AQD+/wEA/////wEAAAAAAP/////+////AQAAAAAA/v8AAAAAAgABAAIAAAD+//7/AAD//wIAAAD+//7/AgABAAAAAAABAAIAAgD+/wEAAgD//wAA/v8BAP7/AgACAP//AAABAP7/AAACAAAA/v8AAAIAAAABAAAAAQAAAAIA/////wEAAQD//wIAAgAAAAEAAgD+/wAAAAD//wEAAgACAAAAAQABAAEA//8CAAEA///+/wAAAgACAAAA/v///wAA/////////v/+////AQACAP7/AQABAAIA//8BAAEAAQD//////v/+/wEA/////wIAAQD+/wIA///+/wEA//8BAAIAAgACAAAAAQACAAIAAQACAAEA//8BAAEAAAD//wAAAgABAP//AAABAP7/AAD//wAAAAAAAAIA/v////////8BAP/////+/wEAAQAAAAIAAQABAP7///8BAAEAAgD+/wIAAQABAP7/AAAAAAEAAQACAAIAAgD//wEA//8AAAEAAQD+/wEAAAABAP//AQD//wIAAgD+/wEAAgACAP7//v8BAP//AQD///7/AAABAAAA//8BAAAAAAABAAAAAQAAAP7/AQD+/wIA/v8AAP///v/+//7///////7/AgD///////8BAP7/AgD//wEAAAAAAP//AgACAP7///8AAP7/AgD+/wAAAgABAAEA///+/wIA///+/wAAAgD+/wIA/v8AAAIAAQAAAP7/AgAAAP7/AQABAP7/AQAAAAEA//8BAP//AgAAAAIAAgABAAEAAQACAAAAAAD///7/AAABAP//AQACAAIAAQAAAP7/AQAAAP//AQD//wAAAAAAAAAAAgAAAAIA/v8CAP///v///wEAAQACAP//AQABAAEA/v/+/wAA//8BAP//AAACAAAAAQACAAIAAAABAAIAAAAAAAEAAAAAAAAA///+////AAD+/wIA////////AQAAAAIAAgACAAAA/v///wAA//8AAP//AAD+/wIA//8AAP7//v8CAAAA//8BAP7//v8CAAAAAQABAAEAAAD///7/AAABAP7//v8BAAEA/v8CAP7//////wIAAAD+/////v8CAAEAAgACAAIA//8CAAEAAQABAAAAAgABAAAAAgACAP7/AgD+//////8AAP7/////////AgD+/////v8BAAEAAgABAAAA/v///wAAAAABAP7///8AAAIA//8BAP7/AgD/////AAD///7//v///wAAAgACAAAAAQD+/wEAAAABAAAAAgACAAEAAQD+/wIA/v8BAAAAAgAAAP7//v///wIAAgD+/wAAAgD+////AQACAAEAAAD//wIAAQABAP7/AQAAAAEAAAAAAP7///8AAAEAAQAAAAEAAgD+/wEA/v8AAAAAAAD+/wEAAgD+/wIAAQABAP7///8CAAAAAgABAAEA/v///wAAAgD//wAAAQABAP7//v8CAP////8AAAIA/v8CAAEA/v////7/AQD+////AQAAAAIAAAABAAEAAQD//wEAAgD//wEA//8CAAIA///+/wAAAQAAAAIAAAD+/wAAAAACAAIAAQD//wEAAgABAAAAAAACAAIAAQABAAAA/////wIAAQD//wEA/v8AAAEAAQABAP//AQD+////AgACAAAA/v8BAP7/AgABAP7///8BAP///v8BAAAAAAACAAEA/v8AAAIAAQAAAAEAAgD+/wIA/v///wAA///+/wEA/v/+/wEA//8AAP7//v8AAP7/AAAAAAAAAQD/////AgABAAIA/////////v8CAAEAAgD//wEAAgD/////AQAAAAEAAAD+/wEAAAACAP///v8BAAAAAgAAAAEAAAABAAAA//8BAAEA/v///wEAAgAAAAIAAAAAAP7/AQAAAP7/AgD+/wIAAQAAAP//AgAAAP////8CAAAA///+//7/AAABAP7/AgAAAP///v8AAAAAAQD///////8CAAAAAgACAAAA//8AAAEAAAAAAP7/AQD+//////8BAAIAAAD+/wEA/v8AAAIA/v8BAAAAAAACAAEAAAD+////AQD+/wIAAgAAAAIA///+/wEAAAABAP7////+//7/AAABAP7//v///wIA//8BAAEAAAACAAEAAgD//wEA/v8BAAIAAQAAAP7/AAD//wEAAQD//wAA/v8AAAIAAAD+/wEAAAD///7/AQD+////AgD+//7/AAD/////AgD///7/AgD//wIA/////wAA//8CAP7/AAD/////AgAAAP///v/+/////v8AAP//AgAAAP7///8AAP7///8BAAIA/v/+/wEAAQAAAAIAAgD+/wEAAgD//wIA/v8CAAAAAQD+//7/AQABAAEA/v8BAAEA/v/+/wAAAgD///7///8AAAIAAgACAAAAAQACAAIAAAABAAIAAgABAP7//v8CAP//AQABAP//AQAAAAEAAQABAP7/AAABAAAAAAAAAP//AQD+//7//v/+/wEA/v8AAP//AgD+/wIAAgACAAAA/v8BAAAAAQD+/wAAAgAAAAAA/v8CAAIA/////wEA///+/wAAAgAAAP7/AAACAP//AQACAAIAAgACAP7/AgAAAP7///8AAAAAAAAAAP7//////wIAAQD+/////v/+/wIA//8BAAEAAQAAAP//AAAAAAAAAgACAP7//v//////AgD+//7/AAABAAEAAQACAAEAAQAAAP//AgD+/wAAAQD+/wAAAgABAAIAAAD+////AQACAP7//v///wAA/////wAAAAAAAP7//v8BAAEA/////wEAAgD//wIAAgAAAP7/AQD+/wEA/v8BAP7/AAACAAEAAgABAAEAAAD+/wEA/v8AAP//AgABAAAA/v8BAP7///8BAAIAAQACAP7/AQAAAAAA//8AAP///v8CAP7/AgACAP//AAAAAP/////+////AAD/////AgD///7///8BAAEAAgACAAEAAgACAAAAAAD//wEA/v8BAAEAAAAAAAIA/v8AAAIA/v8AAAEAAQD+//7/AAAAAP7//v8CAAIAAgABAAEAAgACAP7/AQACAP//AAACAAEAAgD///7/AQD+/wAA/v8CAP///v///wEAAQACAAIAAgD//wAAAAAAAAEAAQAAAAIA/v8AAP7/AAD+/wIAAQAAAAAAAgD//wAA/v8CAP//AAAAAAEA//8CAP7/AAACAAEAAAD//wIA/v8BAAIAAAD+/wAAAAD/////AAABAP///////////v8AAP7/AgACAAIA/v8AAAIA//8CAAEA////////AgD//wEA/v8BAAAA//8BAAIAAAABAP//AgD//wAAAQD//wAAAgABAAEAAAABAAIAAgABAP////8CAP//AAD+/wEAAAACAP7/AgD+/wAA/v///wAAAQACAP//AQD+////AQAAAP7/AQD+/wEAAgAAAP//AQD+/wAA///+/wAA/v8AAP/////+/wAAAQD//wEAAQACAP7//v/+/wAA/////wIAAgACAAEA/v8AAP//AAD+//7///8BAAIAAQD+//7/AQACAAIA/v8CAAIA/////wAAAQD+/wIAAAD//wIAAQD///7/AgAAAP7/AgACAAIAAgACAP7/AQABAP7/AQAAAAAA/v8AAP7/AAD///7/AgAAAP///v8AAAIAAAD//wEAAQD//////v8BAP7/AAD///7////+/wAAAAACAAEAAgABAAAA/v///wAAAAD+/wAAAAD+/wAAAQABAAEAAQAAAP//AQABAAAAAgAAAP7/AQD+/wEAAgD//wIAAAAAAP7//v8AAAAAAAABAAIAAQD//wEAAAABAP7/AAACAAEAAAD+//7/AQAAAAIA///+////AgABAP7////+////AAAAAAEAAgD+/wIA//8BAAAAAAABAP7/AgD//wIAAAABAAAAAAD///7//v///wEAAgABAAIA/v8AAAAAAQD//wIAAAABAP///v////7/AQD//wEA/v8AAAAA/v8CAAIAAAAAAP////8AAAIA///+/////////wEA/v8AAAIAAgAAAAEAAgD//wIA/v/+/wAAAQABAAIAAQABAAIA/v///wAA/v8BAAEAAgAAAP//AgACAP////8BAAIA/v/+/wIA//8AAP////8AAP//AAACAAAA/v8AAP//AgAAAP//AAACAAIA/v8CAP//AgACAP////8CAAIAAAACAP7//v/+//7/AgAAAP//AgABAAIA/v8BAAIAAAAAAAEA//8BAAAAAQD+//7///8BAAEAAQABAP//AAACAP//AAAAAAAAAQD//wAAAgACAP7/AAD//wEA/v8AAAEA//////7//v8AAAEAAgABAP////8AAAIAAAD/////AQACAAEAAQAAAAEA/v/+/wEAAgABAP////8CAAAA/v/+/wAAAQACAAEAAAACAP7//v8BAP//AAAAAAEAAAD+/wEA/v8CAAIA//8AAAIAAAD+/wEAAgABAAIAAAACAAIA/v////7/AQAAAAAAAgAAAP////8CAAIAAQACAP7//v/+////AAABAAIAAQD//wIAAgD//wAAAgAAAP//AQACAAAAAgAAAAIAAgACAAEAAgAAAAEA/v8AAAAA/v8BAAIAAAD+/wIAAQAAAAIAAgD///7/AgABAP//AgACAAEA//////7/AgD+/////v8BAAAAAQD//wEA//8BAAIAAgABAP7///8CAP//AgAAAAEAAgABAAAA//8BAAIAAAACAAAAAAACAAEA/////wAAAgAAAP//AAAAAP//AQAAAAEAAAACAAAAAAD+/wIAAgABAAEAAAD//wAA/v8AAP7/AAABAAAAAQD/////AgAAAAIAAAD///7/AgACAP/////+/wIA//////7//v8BAAAAAQD+/////v8CAP//AQABAAEA//8AAAAAAAD+//7/AgD//wIA/v///wEA///+/wEAAQD//wAA/v/+/wAAAgACAP7/AAAAAAEAAgACAAEA//8CAAEAAAD///7/AAD//wEAAAD///7/AAAAAAIA/////wIAAQABAAIAAAD+/wEA/v//////AQAAAP///v8AAAEA//8BAAAAAAAAAAIAAgD+/wAAAAD///7//v8BAAAA//8BAAIAAAD+/wAAAAACAP///////wEA//8BAAIAAAABAAIAAQACAP////8CAP7/AgABAAIAAAD+/wIA/v/+/wIAAgD//wIAAgD/////AAACAAEA/v///wIAAQD+/wIAAQD+/wEA//8CAAEAAQACAP7/AgABAAAA/v8BAAAA/v///wIA/v/+/wEAAAD+/wIA/v/+/wEA/v8AAAEA/////wEAAAABAAEAAQABAP7/AgD//wAA/v///wIAAQACAP/////+//7/AAABAAIAAQACAAEA/////wEAAAD//wAA///+//7/AQACAP7///////7//v8CAP7/AQACAP7////+/wEAAQD//wIA///+////AgAAAP//AgAAAAIAAgAAAP//AAD//wIA//8BAAAAAAD+/wIAAgD//wEAAgABAP7/AAABAAIAAAABAAEA//8AAAEA//8CAAEA/////wAA//8BAP7/AgABAAEAAgACAP//AQD//wAA//8AAP7/AQAAAP7/AgD///7/AAABAAIAAgD+//7///8CAAIA//8BAP//AAAAAP7///////7/AQD//wIA//8BAP//AgAAAAAAAQABAAIAAAAAAAAAAAACAAEAAQD+/wEAAAD//wAAAAABAP7/AgD//////v8AAAIAAgACAAEAAAD/////AAD//wEAAgD//wEAAgAAAAAAAQABAAEA//8AAP////8CAAEA//8CAP7/AgD+//7//v/+/wEA//////7////+////AgABAAAA/v8CAAIAAQABAP7//v8CAAIAAQD+//7/AgAAAAIAAAD+/wIAAQD///7//v8CAP///////wIAAgAAAAAAAAABAP7/AAABAAEAAgD/////AAD+//7//v8BAAEAAQACAAEA/v/+/////v8BAAEAAAACAP7/AgD+//////8CAAEAAAD+//7/AAACAAIA/v///wAA/v///wIA//8BAP7/AAD//wIA//8CAAEAAgAAAAEA///+/wIAAAD+//7/AQD///7/AAACAAIAAgABAAAA/v8AAAEAAQD//wAAAgABAAEA//8CAAEA/v8CAAAA///+//7/AAD//wEA//8BAAAAAAD+//7//v8AAAEAAAAAAP7////+////AQABAAIAAgACAAEA/v/+//7/AAACAP7/AgACAAAAAQD+/wAAAQABAP7/AgD//wIAAgD//wEA/////wAAAAAAAAEA///+////AQAAAAEAAAABAP7/AAAAAP//AQACAAIA//8BAP7///8AAP7/AQAAAAIAAQAAAAEAAAABAAIA//8AAAAAAgD//wEAAAD//wEAAAAAAAEAAgD//wAAAQAAAAEAAAD+/wIA//8CAAIA//8CAP7/AQD//wEAAAD+/wEAAQD//wAA//8AAP//AQABAP7/AQACAAEAAgABAAIAAgABAAIA/v8AAAIAAgD+//7///8AAP//AgD+/wIAAQAAAAEA/v/+//7/AAD//wIAAgACAAIAAgD//wEAAAABAAEAAgACAP//AAD+/wEA/v8AAAEA/v/+////AAAAAAAAAQD//wIAAQAAAAEA/v8BAAEAAAD+/wAA/v/+//7/AAD+//////8CAP//AgD//wAAAgABAAEA//8BAP////8BAAEA/v8CAP//AQACAAEAAQD+//////8AAP7/AgD+/wIA//8AAAAA//8BAP7/AAABAAIAAAACAAEAAgABAAIA/v8AAAAAAQACAP//AAACAAIA/v///wAA/v///wAA/v///wAA//8CAAEAAQACAP//AgABAAEA//8BAAIA//8CAP//AQAAAP////8AAAEAAgD+/wAA/v8BAP////8BAAIAAgABAAEAAQABAAEAAQD///7/AgD+////AAD+/wAA//8CAAAA//8BAAIAAQACAAIA/v8CAP7/AAACAAAAAgD+/wEAAgD//wEA/v///wAA/v8BAAAAAAD+/wEA/v//////AgAAAAIAAQD//wIA/////////v8CAAAAAgAAAAIAAgD//wAAAAAAAAIAAAACAP7///8BAP7/AAD//////////wAA//8BAAEA//8CAAAAAQABAAEA/v/+/wEAAgAAAAAAAQABAAAAAgD+//7/AQAAAP7/AgABAP//AQD//wEAAAAAAAAAAAACAAIA//8CAAEAAAD+//7//v8BAP7//v///wEAAQD+/wEA/////wAA//8AAP7/AAAAAP7/AAD///7/AQAAAP//AQD+//7//v///wEA/v///wIA//8CAAEA/v/+/wAA/v8BAP//AQD+////AQD+//7//v8AAAAAAAD//wEA//////7/AgACAP7/AgD//wEAAAD/////AQACAAEA///+//7////+/wIAAQAAAAEAAAD/////AAD+////AgACAAIAAgAAAP7/AAD//wIAAgACAP//AQAAAP7///8BAAEA/v///wEAAgD+/wIA/v8AAAAA//8BAAIAAQAAAAIA//8BAP7//v8CAP7//v8AAP///v/+/wEAAgAAAAIAAQABAAEA/v8CAAIAAgD//wAA/v8AAP7/AgD/////AgAAAAEAAgD+/wAAAQD///7////+/wEA/v8BAAIAAgD+/wAA///+//7////+////AQAAAAIAAgAAAP//AAD//wAA/v/+/wAAAQAAAAIA/v8AAAIA/v8BAAEAAgAAAP7/AQACAP//AAD//wAA/v8CAP7///8CAP7//v/+/////v8BAAAAAQD//////v8CAAEA//8AAP//AQAAAAAA/v8CAAAA/v8CAP7//////wIA/v8BAP7/AQAAAAAAAAD+/wIAAQD+/wAA//8AAAIAAAACAP//AQAAAAIAAQD//wIA//////7/AQD+////AgAAAP7/AAD+/wEAAAD+////AgD//wEAAQD+////AAD+//7///8CAAEAAAABAP7/AgD+/wIA//8BAP7/AgACAP7/AQD/////AAAAAAAAAQAAAAAAAQAAAP///v//////AgD+/////v///wEAAQAAAAEA/v8CAAAA//8BAAAAAQAAAP7//v///wAAAgD+////AAD///7///8AAAEAAgD+/wAAAAD///7/AQABAAIAAgD///7/AQD+/////v/+//7/////////AQAAAP7/AgACAAAA/v/+//7///8BAP///v8AAP7//v8BAP7///8CAAEAAQABAP7/AQABAP//AAD/////AAAAAAEA///+/wIAAgACAP//AAABAAEAAgABAP7//v8AAAEA//8BAP//AgD//wIA/v8BAAAAAQACAAEAAAACAAIAAAABAAAA///+/wAAAgD///7/AAD+/wEAAgAAAAIA//////7//////wAAAgD+////AgABAAAA////////AgAAAAAAAgD+/wAAAgACAP//AgD//wEAAgAAAP//AQD+//7//v///wIA///+/wIAAQD+/wAAAgD/////AAD//wAA/v/+////AgD///7/AgAAAP7/AAABAAIA/v8AAAAAAAD/////AQABAAAA//8CAAIAAAD//wIA//8BAAAAAAD//////v8CAAEAAgD+////AgAAAAIA//8CAP7/AQD//wAA/v///wAAAAD///7/AAABAP7/AAD//////v8AAAAA/v/+//7/AQABAAEA//8BAAEAAQAAAAIAAQD+/wEAAgD/////AQD+//7/AAD+/wAAAAD+//7/AAD//wEA///+/wIA/v8AAAIAAgABAP7/AQD//wIAAQD///7//v8AAP////8BAAIAAgAAAAAAAAD///7//v8BAAIAAgABAP///v8AAP7/AQD+/wAAAgABAP///v/+//////8AAP7/AQD+/wAAAQABAAEAAAD+/wIAAQD//wAAAQAAAP//AQD+/wAAAQABAAAA//8AAAIA/v////7//v8AAAIAAQACAP//AgD+/wEAAgABAAIAAQACAP//AQAAAP7/AQD+/wIAAgACAAIAAgD///7/AQD//////////////v8BAP7/AQD/////AgAAAAAA/v/+/wEAAgABAAIAAAAAAAIAAQD+/wIAAgACAAEA/v8BAP////8CAAIAAgD+//7/AgD+/wAAAgAAAAEAAAABAAEAAgACAAEA/v///wAAAQD//wIAAgABAP7/AQAAAP///v8BAAAAAAD+/wAAAAAAAAAAAQD+//////8AAAEAAAAAAAEAAgD+////AQD//wEAAQACAAAA/v8CAP///v8AAAIAAQD//wIAAgD+//////////7////+/wEA/v8AAP//AAAAAAEAAgABAP7//v///wAAAQACAAEA//8BAAIAAgAAAAAA//8AAP7/AAD+/wEA/v///wIA//////////8AAAEAAgD+//7/AQD/////AgD+////AAACAAAAAAABAAEAAAABAAAA//8BAAAAAgACAAEAAgD+//7/AgAAAAIAAgACAAAAAAD+/wEA/v8AAAAAAAAAAAAAAAD/////AgD///7/AgABAAAA///+/wEAAAAAAAEAAQABAP7/AgACAP//AAD//wIAAQAAAAIAAAD//wIA//8AAP7/AQD//wAAAgD//wAA/v///wAA//8AAAEAAAAAAAAAAgAAAAEA/v8BAP7/AgACAAIA/v8BAP//AgD+/wEAAgAAAAEA/v////////8AAAEAAgABAP//AAD///7/AQAAAP//AAD+//7/AQAAAP////8CAP//AQD+////AgABAAEAAQABAAEAAQD+//7/AgD//wAA/v8AAAIA///+//7//////wAAAAD///7/AQACAAIAAAD///7//v8AAAAAAQACAAIAAgAAAAEA//8AAAEAAAD/////AQD+/////////////v8CAAIA///+/wAA/v8BAAAAAgACAP7/AgD+//7//v/+//7/AQABAAEA/v8CAAAAAQD//////v8AAAEA/v8CAAAAAgACAP//AQD+/wIAAgD+/wAA/v/+/wEA//8CAP//AAACAP//AAABAAAA///+/wIAAQD//wEAAAD///7//v/+//7/AgABAP///v8CAP7//v8AAP//AQAAAAAAAQD+//7////+/wAAAAAAAAEA/v/+//7//v//////AAAAAAEAAgAAAP7/AAAAAP///v8BAAEAAQAAAAEAAQABAP///v////7////+/wEAAgABAAIAAQD//wIAAQAAAAIA/v///wEAAQD+/wEAAQD+//7/AAAAAP7/AgACAAIA//8AAAIAAgACAP7/AQD//wEAAAABAP//AgACAP7//v///wIAAQABAP///v8BAAAA//8AAAAA/v8CAP//AgABAAEA///+/wEAAQACAAEA/v8BAAEAAAD+/wEA/v/+/wEAAQD+/wIAAgD+//7/AgACAAAAAgACAP//AQAAAAAA/v///wEAAAACAAIAAgABAAAAAQD+//7////+/wAAAAAAAAIAAgAAAP7//v///wEA//8BAP7/AAACAP/////+/wEA//8BAP//AAD+/wEA/v8CAP7/AQABAAIAAgD//wEA/v8CAP7/AgABAAIAAQACAP//AgD//////v8BAAIAAgAAAAIAAQABAAIA//8AAAEAAAAAAAEA/////wEAAgACAAAAAgAAAAIA////////AgAAAAAA/////wIAAgAAAP7/AAACAAEAAgACAAEAAgAAAAEA/v8CAP7//v8BAP///v/+////AAD//wAAAAD///7/AAD//wIA/v8AAAEA/v8CAAIA//8CAAEA//8CAAAA/v8BAAEAAQAAAAIA/v/+/wAA//8CAAEA//8AAAIAAgACAP////8AAAEA///+//////8CAP7/AQD+/wEAAAACAAAA/////wIAAAD+/wAAAQD///7///8AAAIA/v8CAAAAAQACAAIAAAD+/wAAAgD/////AgD+/wIA//8BAAIAAgABAP7/AAD/////AAAAAAAAAAD//wIAAgABAAIA/v/+/wAAAQD//wIAAgD///7/AAABAP7/AQAAAAIAAAD+/wIAAAACAAIAAQABAP7/AAD//wAAAgD+//7///8CAAIA/v/+//////8BAP7///8CAAEA/v////7/AQAAAP7//v/+//7///8AAAIA/v8CAP//AAABAAEAAQABAAEAAAD+/wEA/v8CAP7/AgD+/wIA/v/+/wAAAgD+/wAAAAACAP7/AAABAAEAAQD+/wEA//8CAP////8BAAIAAAD//wAAAAD+/wIAAgD///7//v/+/wIAAgABAAIAAgD+/wAA//8AAP//AQACAP//////////AgAAAP///v///wIA/v8CAAEAAgD+/wAA/v8AAP7///8CAAEAAAAAAP/////+/wAAAgD+////AAABAAEAAAACAAAAAgD//wIAAgAAAAAAAQD///7/AAD/////AQAAAAAA//8AAAEAAQABAAAAAAABAAIA/v///wIA/v8AAP//AgD//wAA/v/+//7/AgD+/wIAAgABAAIA///+/wIAAAACAAIAAQD//wAAAQD//wIAAAA=';

let autoplayUnlocked = false;
let pendingPlayFn = null;   // a play() that got blocked and waits for unlock

function unlockStatusEl() {
    return document.getElementById('sm-autoplay');
}

function renderUnlockStatus() {
    const el = unlockStatusEl();
    if (!el) return;
    if (autoplayUnlocked) {
        el.textContent = '🔓 Autoplay: unlocked for this session';
        el.style.color = '#4caf50';
    } else if (pendingPlayFn) {
        el.textContent = '🔒 Autoplay: locked — playback queued, click anywhere to unlock';
        el.style.color = '#e0a800';
    } else {
        el.textContent = '🔒 Autoplay: locked — will unlock on first click/keypress';
        el.style.color = '#888';
    }
}

function tryUnlockOnce() {
    if (autoplayUnlocked) return;
    try {
        const u = new Audio(UNLOCK_WAV);
        u.volume = 0.01;
        const p = u.play();
        if (p && p.then) {
            p.then(() => {
                autoplayUnlocked = true;
                const fn = pendingPlayFn;
                pendingPlayFn = null;
                renderUnlockStatus();
                if (fn) fn();
            }).catch(() => { /* still locked; listeners stay armed */ });
        } else {
            autoplayUnlocked = true;
        }
    } catch (e) { log('unlock attempt failed:', e && e.message); }
}

function armUnlockListeners() {
    const handler = () => {
        tryUnlockOnce();
        if (autoplayUnlocked) {
            document.removeEventListener('pointerdown', handler, true);
            document.removeEventListener('keydown', handler, true);
        }
    };
    document.addEventListener('pointerdown', handler, true);
    document.addEventListener('keydown', handler, true);
}

// Play wrapper: if the browser refuses (NotAllowedError), queue the play
// and fire it automatically right after the unlock succeeds.
function guardedPlay(a) {
    const p = a.play();
    if (p && p.catch) {
        p.catch(err => {
            if (err && (err.name === 'NotAllowedError' || /not allowed|interact/i.test(String(err.message)))) {
                pendingPlayFn = () => { a.play().catch(e => log('play blocked after unlock:', e && e.message)); };
                log('play blocked by autoplay policy — queued until first user interaction');
                renderUnlockStatus();
            } else {
                log('play failed:', err && err.message);
            }
        });
    }
}

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
    guardedPlay(a);
    currentId = id;
    renderPlaylist();
    return true;
}

function toggleTrack(id) {
    if (audio && id === currentId) {
        if (audio.paused) {
            guardedPlay(audio);
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
        if (a.paused) guardedPlay(a);
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

const AUDIO_EXT_RE = /\.(mp3|wav|ogg|oga|m4a|flac|aac|opus|webm|mp4)$/i;

function mimeFromName(name) {
    const m = String(name || '').toLowerCase().match(/\.[a-z0-9]+$/);
    if (!m) return '';
    return ({
        '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
        '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.flac': 'audio/flac',
        '.aac': 'audio/aac', '.opus': 'audio/ogg', '.webm': 'audio/webm',
    })[m[0]] || '';
}

async function addFiles(fileList) {
    const added = [];
    for (const file of fileList) {
        if (!file) continue;
        // Accept anything that declares as audio OR has an audio extension.
        // Downloaders often hand files over with no/generic MIME type
        // (application/octet-stream) — the extension is the real signal.
        const declaredAudio = !!(file.type && file.type.startsWith('audio/'));
        const extAudio = AUDIO_EXT_RE.test(file.name || '');
        if (!declaredAudio && !extAudio) {
            log('skipped non-audio file:', file.name);
            continue;
        }
        const type = declaredAudio ? file.type : (mimeFromName(file.name) || 'audio/mpeg');
        const blob = (typeof File !== 'undefined' && file instanceof File)
            ? new File([file], file.name, { type })
            : new Blob([file], { type });
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        const track = { id, name: file.name, type, blob };
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
                <div id="sm-autoplay" class="muted" style="font-size: 0.85em; margin: 0.25em 0;">🔒 Autoplay: locked — will unlock on first click/keypress</div>
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

    armUnlockListeners();
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
        autoplayUnlocked,
    }),
};
