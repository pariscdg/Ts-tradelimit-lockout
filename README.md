# TradeSea One Trade

A Chrome extension that starts an eight-hour account lockout when an open trade returns to flat.

## Setup

1. Download this repository and extract it.
2. Open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**.
3. Select the `extension` folder.
4. Sign in to TradeSea in Chrome and reload the trading tab.
5. Open the extension, choose an account, and click **Protect this account**.

Keep the TradeSea tab open while trading and check that the extension shows **Monitoring**.

Accounts with an active TradeSea lockout show **Locked until** and their end time in the dropdown. Other accounts remain available.

The extension sends one eight-hour lockout request after a completed trade. There is no confirmation-pending workflow or automatic resubmission. TradeSea's current timer controls the displayed lock status.

Local extension protection can be disabled and cannot guarantee an irreversible lockout.

Tests: run `npm test` with Node.js 22 or newer. Tests use simulated accounts and do not place trades.
