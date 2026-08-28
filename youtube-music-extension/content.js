// Polls the local PlaylistManager server for readiness.
// When the server is up and /status returns {ready: true},
// extracts the current song URL and sends it once.
//
// Uses exponential back-off when the server is unreachable to
// avoid excessive network churn between keybind presses.

const SERVER_URL = 'http://127.0.0.1:5000';
const POLL_INTERVAL_MS = 500;
const MAX_BACKOFF_MS = 8000;
const BACKOFF_FACTOR = 2;
const CONSECUTIVE_FAILURES_RESET = 5;

let polling = false;
let pollTimer = null;
let sentThisSession = false;
let consecutiveFailures = 0;
let currentInterval = POLL_INTERVAL_MS;
// The server issues a fresh per-flow token on every keybind press.
// Tracking it lets us detect a brand-new flow even when the server was
// never observed going down between two quick keybind presses (which
// would otherwise leave sentThisSession stale and the new flow waiting
// forever for a URL).
let lastToken = null;

// Most recent song URL sampled on any poll (ready or idle).  Used to fix a
// track-rollover race (see pickSongToSend): if the song visibly changes in
// the window straddling a keybind press, the user was pressing for the
// PREVIOUS song, so we fall back to this buffered URL instead of eagerly
// sending whatever the player just rolled onto.
let lastUrl = null;

// Extract the clean YouTube Music URL for the current song.
function extractSongUrl() {
    try {
        // Method 1: player bar link
        const playerLink = document.querySelector('div.ytp-title-text a[href*="/watch"]');
        if (playerLink) {
            const href = playerLink.getAttribute('href');
            if (href) {
                const videoId = new URL(href, location.origin).searchParams.get('v');
                if (videoId) return `https://music.youtube.com/watch?v=${videoId}`;
            }
        }
    } catch (_) { /* ignore */ }

    // Method 2: video ID from page URL
    const match = location.href.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
    if (match) return `https://music.youtube.com/watch?v=${match[1]}`;

    return null;
}

function sendUrl(url, token) {
    return fetch(`${SERVER_URL}/receive-url`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-PM-Token': token,
        },
        body: JSON.stringify({ url }),
    }).then(resp => {
        if (!resp.ok) throw new Error(`Server error: ${resp.status}`);
        return resp.json();
    });
}

// Is this tab the one actually playing music?  With several YT Music
// tabs open the server accepts the first URL it receives - a paused
// background tab would race the playing one.  Paused tabs (the video
// element exists and is paused) must stay silent; when no player element
// is found yet (page still loading) we send anyway rather than drop.
function isTabPlaying() {
    const video = document.querySelector('video');
    if (!video) return true;
    return !video.paused;
}

function poll() {
    fetch(`${SERVER_URL}/status`)
        .then(resp => resp.json())
        .then(data => {
            // Server responded — reset back-off
            consecutiveFailures = 0;
            currentInterval = POLL_INTERVAL_MS;

            if (data.ready) {
                // New flow detection: the token changes per keybind press.
                if (data.token && data.token !== lastToken) {
                    lastToken = data.token;
                    sentThisSession = false;
                }
                if (!sentThisSession && isTabPlaying()) {
                    const url = extractSongUrl() || lastUrl;
                    if (url && data.token) {
                        sentThisSession = true;
                        // Keep the idle-sampled buffer fresh for the NEXT
                        // flow, but decide what to send from the song that
                        // was current BEFORE this flow became ready.
                        const chosen = pickSongToSend(url);
                        lastUrl = url;
                        sendUrl(chosen, data.token).catch(() => {
                            // The POST was rejected (flow ended, token mismatch,
                            // server raced away) — allow a retry on the next poll
                            // instead of silently dropping the song.
                            sentThisSession = false;
                            consecutiveFailures++;
                            currentInterval = Math.min(
                                currentInterval * BACKOFF_FACTOR,
                                MAX_BACKOFF_MS
                            );
                        });
                    }
                }
            } else {
                // Server acknowledged or flow ended — reset for next keybind.
                // Keep the buffer fresh so a flow that flips ready mid-rollover
                // can still fall back to the song playing just before.
                lastToken = null;
                sentThisSession = false;
                const idleUrl = extractSongUrl();
                if (idleUrl) lastUrl = idleUrl;
            }
        })
        .catch(() => {
            // Server is down — that's expected between keybinds
            lastToken = null;
            sentThisSession = false;
            consecutiveFailures++;
            if (consecutiveFailures >= CONSECUTIVE_FAILURES_RESET) {
                currentInterval = Math.min(
                    currentInterval * BACKOFF_FACTOR,
                    MAX_BACKOFF_MS
                );
            }
        });
}

// Decide which song URL to send when a flow becomes ready.
//
// The content script samples the player asynchronously from the keybind
// press (the flow becomes "ready" on the next poll after the press).  A
// song that ends near the press can roll over in that gap, so the player
// now shows the NEXT track while the user pressed for the PREVIOUS one
// (the reported bug: pressing in the last ~2s of a song adds the next one).
//
// `current` is what the player shows at this poll; `lastUrl` is what it
// showed immediately before.  When they differ, the change happened exactly
// in the window straddling the press, and the user was hearing the OLD song
// when they pressed — so send the buffered (previous) URL, not the one the
// player just rolled onto.  When they agree (the normal case: a song has
// been playing for a while), send `current` unchanged.
function pickSongToSend(current) {
    if (lastUrl && lastUrl !== current) {
        return lastUrl;
    }
    return current;
}

function startPolling() {
    if (polling) return;
    polling = true;

    function schedule() {
        if (!polling) return;
        poll();
        pollTimer = setTimeout(schedule, currentInterval);
    }

    schedule();
}

// Start polling as soon as the content script loads on a YouTube Music page.
// The server is only up for ~30 s per keybind press, so most polls return
// immediately with {ready: false} or fail fast when the server is down.
startPolling();

// Also re-capture on navigation in case the content script is reused
window.addEventListener('popstate', () => { sentThisSession = false; });
window.addEventListener('hashchange', () => { sentThisSession = false; });
