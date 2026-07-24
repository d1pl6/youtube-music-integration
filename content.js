// Remove list parameter and keep only video ID
function cleanSongUrl(url) {
    try {
        const urlObj = new URL(url);
        const videoId = urlObj.searchParams.get('v');

        if (videoId) {
            // Reconstruct URL with only the video ID parameter
            return `https://music.youtube.com/watch?v=${videoId}`;
        }
    } catch (e) {
        console.error('Error cleaning URL:', e);
    }

    return url; // Return original if cleaning fails
}

// Method 1: Get from player bar link
// Method 2: Get from video ID in URL (if player is open)
function extractSongLink() {
    const playerLink = document.querySelector('div.ytp-title-text a[href*="/watch"]');
    if (playerLink) {
        const href = playerLink.getAttribute('href');
        if (href) {
            return cleanSongUrl(href);
        }
    }

    const videoIdMatch = window.location.href.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
    if (videoIdMatch) {
        return `https://music.youtube.com/watch?v=${videoIdMatch[1]}`;
    }

    return null;
}

// Capture and log URL
function captureAndLogURL() {
    const songUrl = extractSongLink();

    if (songUrl) {
        console.log('Captured clean URL:', songUrl);

        // Send to background script
        chrome.runtime.sendMessage({
            type: 'LOG_URL',
            url: songUrl
        });
    } else {
        console.log('No song URL found');
    }
}

// Capture URL when page loads
captureAndLogURL();

// Capture when URL changes (for single-page app navigation)
const observer = new MutationObserver(() => {
    captureAndLogURL();
});

observer.observe(document.body, {
    subtree: true,
    childList: true
});

// Listen for URL changes in single-page apps
window.addEventListener('popstate', captureAndLogURL);
window.addEventListener('hashchange', captureAndLogURL);