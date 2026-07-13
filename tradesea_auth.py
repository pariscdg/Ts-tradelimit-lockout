"""Obtain a TradeSea access token through a normal, persistent browser login."""

from __future__ import annotations

import os
import base64
import json
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse


APP_URL = "https://app.tradesea.ai/"
COOKIE_NAME = "access_token"
PROFILE_DIR = Path(__file__).with_name(".tradesea-browser-profile")


@dataclass(frozen=True)
class TradeSeaSession:
    access_token: str
    websocket_url: str
    account_id: str


def _access_token_from_cookies(cookies: list[dict[str, object]]) -> str | None:
    for cookie in cookies:
        if cookie.get("name") == COOKIE_NAME and cookie.get("value"):
            return str(cookie["value"])
    return None


def _token_is_fresh(token: str, *, minimum_lifetime_seconds: int = 60) -> bool:
    """Check a JWT expiry without verifying it; the server still verifies signatures."""
    try:
        payload_part = token.split(".")[1]
        padding = "=" * (-len(payload_part) % 4)
        payload = json.loads(base64.urlsafe_b64decode(payload_part + padding))
        return float(payload["exp"]) > time.time() + minimum_lifetime_seconds
    except (IndexError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        return False


def get_tradesea_session(
    *, headless: bool = False, timeout_seconds: int = 180
) -> TradeSeaSession:
    """Return the token and account-specific WebSocket selected by TradeSea."""
    if os.environ.get("TRADESEA_ACCESS_TOKEN"):
        raise RuntimeError(
            "TRADESEA_ACCESS_TOKEN alone is insufficient; the account-specific "
            "WebSocket URL must be discovered from the TradeSea app."
        )

    return _get_browser_credentials(
        headless=headless,
        timeout_seconds=timeout_seconds,
        require_websocket=True,
    )


def get_access_token(*, headless: bool = False, timeout_seconds: int = 180) -> str:
    """Return the current TradeSea access token.

    A dedicated Chrome profile is kept beside this project. On the first run (or
    whenever TradeSea requires authentication again), sign in in the browser
    window. No password is read or stored by this script.
    """
    configured_token = os.environ.get("TRADESEA_ACCESS_TOKEN")
    if configured_token:
        return configured_token

    return _get_browser_credentials(
        headless=headless,
        timeout_seconds=timeout_seconds,
        require_websocket=False,
    ).access_token


def _get_browser_credentials(
    *, headless: bool, timeout_seconds: int, require_websocket: bool
) -> TradeSeaSession:

    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise RuntimeError(
            "Playwright is required. Install it with: python -m pip install playwright"
        ) from exc

    PROFILE_DIR.mkdir(exist_ok=True)

    with sync_playwright() as playwright:
        try:
            context = playwright.chromium.launch_persistent_context(
                str(PROFILE_DIR),
                channel="chrome",
                headless=headless,
            )
        except Exception as exc:
            raise RuntimeError(
                "Could not start Chrome. Close any Chrome window using the "
                f"dedicated profile at {PROFILE_DIR}, then try again."
            ) from exc

        try:
            websocket_urls: list[str] = []

            def watch_page(browser_page) -> None:
                browser_page.on(
                    "websocket",
                    lambda socket: websocket_urls.append(socket.url)
                    if socket.url.endswith("/ws/unified")
                    else None,
                )

            for existing_page in context.pages:
                watch_page(existing_page)
            context.on("page", watch_page)

            page = context.pages[0] if context.pages else context.new_page()
            page.goto(APP_URL, wait_until="domcontentloaded")

            deadline = time.monotonic() + timeout_seconds
            login_message_shown = False

            while time.monotonic() < deadline:
                token = _access_token_from_cookies(context.cookies())
                websocket_url = websocket_urls[-1] if websocket_urls else ""
                if token and _token_is_fresh(token) and (
                    websocket_url or not require_websocket
                ):
                    path_parts = urlparse(websocket_url).path.split("/")
                    account_id = path_parts[path_parts.index("users") + 1] if websocket_url else ""
                    return TradeSeaSession(token, websocket_url, account_id)

                if headless and not token:
                    raise RuntimeError(
                        "TradeSea login is required. Run once without --headless and sign in."
                    )
                if not login_message_shown:
                    print("TradeSea login required. Sign in in the Chrome window...")
                    login_message_shown = True
                page.wait_for_timeout(500)

            raise RuntimeError(
                "TradeSea did not provide a fresh token and authorized WebSocket "
                f"within {timeout_seconds} seconds."
            )
        finally:
            context.close()
