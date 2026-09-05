"""
YouTube Music auth manager and ytmusicapi wrapper.

All ytmusicapi imports are **lazy** - the module can be imported without
``ytmusicapi`` installed (it is an optional dependency).  The filesystem
side effect ``AUTH_FOLDER.mkdir()`` is deferred to ``YouTubeAuthManager``
instantiation.
"""

import logging
from pathlib import Path
from types import MethodType
from typing import Optional

from platformdirs import user_config_dir

logger = logging.getLogger(__name__)

AUTH_FOLDER = Path(user_config_dir("playlistmanager")) / "auth"
# NOTE: AUTH_FOLDER.mkdir() is deferred to YouTubeAuthManager.__init__()

BROWSER_FILE = AUTH_FOLDER / "browser.json"
# Additional lookup locations for browser.json
# NOTE: keep in sync with plugin.json "auth_file_fallbacks" - uninstall /
# logout delete every declared file, and a fallback copy that is not
# declared here would re-authenticate the platform after removal.
BROWSER_FILE_FALLBACKS = [
    Path(__file__).parent.parent.parent / "browser.json",
    Path(__file__).parent / "browser.json",
]


def _patched_get_library_playlists(self, limit: int | None = 25):
    """Fallback playlist fetch for broken ytmusicapi get_library_playlists.

    Merges the user's playlists AND liked playlists, deduped by id so a
    playlist that appears in both (followed + liked) is not listed twice.
    Each browse page gracefully skipped on error so one broken endpoint
    never loses the other's playlists.
    """
    from ytmusicapi.continuations import get_continuations
    from ytmusicapi.parsers.browsing import GRID, parse_content_list, parse_playlist
    from ytmusicapi.parsers.library import get_library_contents

    self._check_auth()
    browse_ids = ["FEmusic_library_playlists", "FEmusic_liked_playlists"]

    merged: list = []
    seen_ids: set = set()
    last_exception = None

    for browse_id in browse_ids:
        try:
            body = {"browseId": browse_id}
            endpoint = "browse"
            response = self._send_request(endpoint, body)
            results = get_library_contents(response, GRID)
            if results is None:
                continue

            # Filter items: skip the first entry if it looks like a header
            # (no playlistId) rather than unconditionally slicing [1:].
            items = results.get("items", [])
            if items and not _is_likely_playlist_item(items[0]):
                items = items[1:]

            page = parse_content_list(items, parse_playlist)
            if "continuations" in results:
                remaining = None if limit is None else (limit - len(merged))
                page.extend(
                    get_continuations(
                        results,
                        "gridContinuation",
                        remaining,
                        lambda additionalParams: self._send_request(
                            endpoint, body, additionalParams
                        ),
                        lambda contents: parse_content_list(contents, parse_playlist),
                    )
                )

            for playlist in page:
                pid = playlist.get("playlistId")
                if pid and pid in seen_ids:
                    continue
                if pid:
                    seen_ids.add(pid)
                merged.append(playlist)
                # Honour the limit across both browse endpoints so a huge
                # liked list cannot balloon the result past the cap.
                if limit is not None and len(merged) >= limit:
                    return merged[:limit]
        except Exception as exc:
            last_exception = exc
            logger.debug(
                f"get_library_playlists fallback failed for {browse_id}: {exc}"
            )

    if not merged and last_exception:
        raise last_exception
    return merged


def _is_likely_playlist_item(item: dict) -> bool:
    """Heuristic: a playlist item typically has a playlistId or a title."""
    return bool(item.get("playlistId")) or bool(item.get("title"))


def _patch_yt_music_library_playlists(yt):
    """Instance-level patch: replace get_library_playlists on a YTMusic instance.

    Class-level patching is avoided to prevent global side effects on the
    YTMusic class. Every YTMusic instance should be patched individually
    after creation via this function.
    """
    try:
        yt.get_library_playlists = MethodType(_patched_get_library_playlists, yt)
        logger.debug(
            "Patched YTMusic.get_library_playlists with fallback implementation"
        )
    except Exception as exc:
        logger.warning(f"Failed to patch YTMusic.get_library_playlists: {exc}")


class YouTubeAuthManager:
    def __init__(self):
        AUTH_FOLDER.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.yt_music = None

    def _find_browser_file(self) -> Optional[Path]:
        candidates = [BROWSER_FILE, *BROWSER_FILE_FALLBACKS]
        for path in candidates:
            if path.exists():
                return path
        return None

    def _setup_browser_auth(self, browser_file: Path) -> bool:
        from ytmusicapi import YTMusic

        try:
            self.yt_music = YTMusic(str(browser_file))
            _patch_yt_music_library_playlists(self.yt_music)
            logger.info("YouTube Music authenticated (browser auth)")
            return True
        except Exception as e:
            logger.error(f"Browser auth failed: {e}")
            return False

    def setup_auth(self) -> bool:
        """Authenticate using browser.json (preferred).

        A failed attempt must leave the manager unauthenticated - never
        reuse a client built from a now-deleted or replaced browser.json.
        """
        self.yt_music = None
        try:
            browser_file = self._find_browser_file()
            if browser_file is not None:
                logger.info(f"Found browser auth file: {browser_file}")
                return self._setup_browser_auth(browser_file)
            return False

        except Exception as e:
            logger.error(f"Authentication failed: {e}")
            return False

    def is_authenticated(self) -> bool:
        return self.yt_music is not None

    def get_yt_music(self):
        if not self.is_authenticated():
            raise RuntimeError(
                "Not authenticated. Open Settings → Login → YouTube Music "
                "and run `ytmusicapi browser` in the terminal that opens."
            )
        if self.yt_music is None:
            raise RuntimeError("YouTube Music client not initialised")
        return self.yt_music


youtube_auth = YouTubeAuthManager()
