const PYTHON_SERVER_URL = 'http://localhost:5000/receive-url';

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'LOG_URL') {
        const url = request.url;

        fetch(PYTHON_SERVER_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                url: url,
                timestamp: new Date().toISOString()
            })
        })
            .then(response => {
                if (!response.ok) throw new Error(`Server error: ${response.status}`);
                return response.json();
            })
            .then(data => {
                console.log('URL logged:', data);
                sendResponse({ success: true });
            })
            .catch(() => {});

        return true;
    }
});
