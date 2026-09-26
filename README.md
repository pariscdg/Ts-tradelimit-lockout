# TradeSea One Trade

A Chrome extension that starts an eight-hour account lockout when an open trade returns to flat.

## Setup

1. Download this repository and extract it.
2. Open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**.
3. Select the `extension` folder.
4. Sign in to TradeSea in Chrome and reload the trading tab.
5. Open the extension, check your accounts, and turn on **Automatic protection**.

Your choices are saved across Chrome restarts. Each checked account gets one completed trade, then its own eight-hour lockout. Protection resumes automatically when its timer ends.

Keep a connected TradeSea tab open for each account you trade and check that it shows **Monitoring**. Accounts without a live connection show a warning; snapshot checks can miss a trade opened and closed between checks.

Turning off automatic protection keeps your account choices, existing lockouts, and any open trade already being monitored. With automatic protection off, you can still choose an account and click **Protect this account** manually.

Accounts with an active TradeSea lockout show **Locked until** and their end time. Locked accounts are greyed out; other accounts remain available.

The extension sends one eight-hour lockout request after a completed trade. There is no confirmation-pending workflow or automatic resubmission. TradeSea's current timer controls the displayed lock status.

Local extension protection can be disabled and cannot guarantee an irreversible lockout.

Tests: run `npm test` with Node.js 22 or newer. Tests use simulated accounts and do not place trades.
