# TradeSea One Trade

A Chrome extension that starts an eight-hour account lockout when an open trade returns to flat.

## Setup

1. Download this repository and extract it.
2. Open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**.
3. Select the `extension` folder.
4. Sign in to TradeSea in Chrome and reload the trading tab.
5. Open the extension, choose an account, and click **Protect this account**.

Keep the TradeSea tab open while trading and check that the extension shows **Monitoring**.

Locked accounts are marked in the dropdown. You can protect another available account while existing lockouts keep their deadlines.

TradeSea must confirm the server lockout. Local extension protection can be disabled and cannot guarantee an irreversible lockout.

Tests: run `npm test` with Node.js 22 or newer. Tests use simulated accounts and do not place trades.
