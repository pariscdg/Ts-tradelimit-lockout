# Tradesea Auto-Lock Listener

## Summary

This project watches the currently selected Tradesea account for position updates. When it detects a transition from an open position to no position, it sends a lockout request and closes the WebSocket connection.

The listener does not attach to the Chrome window used for trading. At startup, it briefly launches a separate persistent Chrome profile in headless mode to:

1. Load the Tradesea web application.
2. Obtain a fresh `access_token` cookie.
3. Discover the authorized account-specific WebSocket URL.
4. Close the headless browser.
5. Connect directly to Tradesea and listen for account events.

The current listener automatically exits after 40 minutes. The configured lockout duration is currently `20` seconds in `Tradesea_listener.py`.

## Files

- `Tradesea_listener.py` — main listener and lockout logic.
- `Tradesea_auth.py` — retrieves a fresh token and the authorized account details through Chrome.
- `get_cookie.py` — interactive login/bootstrap helper.
- `.Tradesea-browser-profile/` — generated Chrome profile containing the saved Tradesea login. Keep this directory private.

## Requirements

- Windows 10 or Windows 11
- Python 3.10 or newer
- Google Chrome
- An active Tradesea account
- Internet access when the scripts run

Python dependencies:

```text
playwright
requests
websocket-client
```

## Installation

Open PowerShell in the project directory:

```powershell
cd C:\Users\user\Desktop\Tradesea-lockout
```

Install the required packages:

```powershell
python -m pip install playwright requests websocket-client
```

This project uses the installed Google Chrome browser through Playwright's `chrome` channel, so a separate Playwright Chromium download is normally unnecessary.

## First-time setup

Create the persistent browser profile and sign into Tradesea:

```powershell
python get_cookie.py
```

A Chrome window will open. Sign into Tradesea normally. Once a fresh access token is available, the script confirms that it found the token and closes Chrome.

The login is saved under `.Tradesea-browser-profile`. Do not copy this directory to an untrusted computer, commit it to source control, or share it with anyone.

## Running the listener

Run:

```powershell
python Tradesea_listener.py
```

A successful startup looks similar to:

```text
Starting Tradesea Auto-Lock Listener
Authorized Tradesea account selected from the web app
Connected to Tradesea WebSocket
```

You may continue trading in your regular Chrome session. The listener receives server-side updates for the Tradesea account selected by its saved profile.

## Access-token renewal

Tradesea access tokens expire after approximately eight hours. This normally requires no manual action: every new listener run loads Tradesea headlessly and obtains the current token before connecting.

If the longer-lived saved Tradesea login expires, the headless listener will report that login is required. Refresh it interactively:

```powershell
python get_cookie.py
```

Sign in, wait for the confirmation, and then start `Tradesea_listener.py` again.

## Windows Task Scheduler

Run `get_cookie.py` successfully at least once before creating the scheduled task. Since "access_token" expires after 8 hours, it is required that `get_cookie.py` is ran before starting `Tradesea_listener.py` again to acquire the latest "access_token".

Create 2 tasks with a daily morning trigger and use these action settings (Make sure task 1 is scheduled to run before task 2.)

## Task 1: "get_cookie"

- **Program/script:** the full path to `python.exe`, for example:

  ```text
  C:\Users\user\AppData\Local\Programs\Python\Python313\python.exe
  ```

- **Add arguments:**

  ```text
  get_cookie.py
  ```

- **Start in:**

  ```text
  C:\Users\user\Desktop\Tradesea-lockout
  ```

  (This is an example directory, you must use the correct folder path from where you installed this script.)

- **Triggers:**
  Weekly, Mon-Fri
  9:29:00 EST (New York Market Open)
  You can always customize these settings to your liking.


  ## Task 2: "tradesea_listener"

- **Program/script:** the full path to `python.exe`, for example:

  ```text
  C:\Users\user\AppData\Local\Programs\Python\Python313\python.exe
  ```

- **Add arguments:**

  ```text
  Tradesea_listener.py
  ```

- **Start in:**

  ```text
  C:\Users\user\Desktop\Tradesea-lockout
  ```

  (This is an example directory, you must use the correct folder path from where you installed this script.)

  - **Triggers:**
  Weekly, Mon-Fri
  9:29:10 EST (New York Market Open)
  You can always customize these settings to your liking.

Use the actual result of the following command if Python is installed elsewhere:

```powershell
(Get-Command python).Source
```

Initially select **Run only when user is logged on**, then right-click the task and choose **Run** to verify it. Task Scheduler must run under the same Windows user that created `.Tradesea-browser-profile`, because the saved Chrome session belongs to that user.

## Configuration

The following values are near the top of `Tradesea_listener.py`:

```python
LOCKOUT_SECONDS = 20
```

The listener shutdown duration is configured inside `shutdown_timer`:

```python
timeout_seconds = 40 * 60
```

Change these values carefully if a different lockout or listening duration is required.

## Troubleshooting

### Tradesea login is required

Run the interactive helper and sign in again:

```powershell
python get_cookie.py
```

### `ModuleNotFoundError`

Reinstall the dependencies using the same Python executable used by Task Scheduler:

```powershell
python -m pip install playwright requests websocket-client
```

### Chrome profile is already in use

Close any Chrome process that was opened with this project's `.Tradesea-browser-profile`, then rerun the command. Your normal Chrome profile should not conflict with it.

### WebSocket returns `403 Forbidden`

Refresh the saved login with `python get_cookie.py`, then rerun the listener. The current version discovers the authorized WebSocket and account ID dynamically; no account ID should be hard-coded.

### Scheduled task works manually but not on schedule

Verify all three Task Scheduler action fields, especially **Start in**. Also confirm that the task uses the same Windows account and Python installation used during setup.

## Optional verification

The test file can be run with pytest:

```powershell
python -m pip install pytest
python -m pytest -q
```
