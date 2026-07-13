import websocket
import requests
import json
import time
import threading
import os

from tradesea_auth import get_tradesea_session


# ==========================
# CONFIG
# ==========================

WS_URL = None
ACCOUNT_ID = None
ACCESS_TOKEN = None
LOCKOUT_URL = None


LOCKOUT_SECONDS = 20

# ==========================
# RUNTIME
# ==========================

def shutdown_timer(ws):

    timeout_seconds = 40 * 60  # 40 minutes

    print("⏳ Script timeout set for 40 minutes")

    time.sleep(timeout_seconds)

    print("\n⏰ 40 minutes elapsed")
    print("🛑 Closing Tradesea listener")

    ws.close()

    os._exit(0)


# ==========================
# STATE
# ==========================

locked = False
previous_qty = None

# ==========================
# PING
# ==========================

def send_ping(ws):

    while True:
        try:
            ws.send("ping")
            print("ping")

            time.sleep(15)

        except Exception as e:
            print("Ping stopped:", e)
            break




# ==========================
# LOCKOUT FUNCTION
# ==========================

def lock_account():

    global locked

    now = int(time.time())

    payload = {
        "lockoutStartTimeEpoch": now,
        "lockoutEndTimeEpoch": now + LOCKOUT_SECONDS
    }

    headers = {
        "Cookie": f"access_token={ACCESS_TOKEN}",
        "Content-Type": "application/json",
        "Accept": "application/json, text/plain, */*",
        "Origin": "https://app.tradesea.ai",
        "Referer": "https://app.tradesea.ai/"
    }


    print("\n🔒 Sending lockout request...")

    response = requests.put(
        LOCKOUT_URL,
        headers=headers,
        json=payload
    )


    print("Status:", response.status_code)
    print(response.text)


    if response.status_code == 201:
        locked = True
        print("✅ Account locked successfully")
        print("🛑 Closing websocket...")
        ws.close()


# ==========================
# WEBSOCKET EVENTS
# ==========================

def on_message(ws, message):

    global previous_qty


    try:
        data = json.loads(message)

    except Exception:
        return


    event = data.get("event")


    if event == "positionUpdates":

        positions = data.get("data", {}).get("positions", [])


        if not positions:
            return


        # Sum all positions
        current_qty = sum(
            abs(p.get("qty", 0))
            for p in positions
        )


        print(
            "Position count:",
            current_qty,
            "| Previous:",
            previous_qty
        )


        # Detect transition:
        # Open position -> flat

        if (
            previous_qty is not None
            and previous_qty > 0
            and current_qty == 0
            and not locked
        ):

            print(
                "\n🚨 Position closed. Triggering lockout."
            )

            lock_account()


        previous_qty = current_qty



    elif event:
        print("Event:", event)



# ==========================
# ERRORS
# ==========================

def on_error(ws, error):

    print("WebSocket error:")
    print(error)



def on_close(ws, code, msg):

    print(
        "WebSocket closed:",
        code,
        msg
    )



def on_open(ws):

    print("✅ Connected to Tradesea WebSocket")

    # heartbeat
    threading.Thread(
        target=send_ping,
        args=(ws,),
        daemon=True
    ).start()


    # 40 minute shutdown timer
    threading.Thread(
        target=shutdown_timer,
        args=(ws,),
        daemon=True
    ).start()



# ==========================
# START
# ==========================

if __name__ == "__main__":

    print("Starting Tradesea Auto-Lock Listener")

    # Task Scheduler runs this non-interactively. Bootstrap the persistent
    # TradeSea login once with `python get_cookie.py`; scheduled runs can then
    # refresh/read the cookie without opening a visible Chrome window.
    session = get_tradesea_session(headless=True)
    ACCESS_TOKEN = session.access_token
    WS_URL = session.websocket_url
    ACCOUNT_ID = session.account_id
    LOCKOUT_URL = (
        "https://prod-identity.tradesea.ai/"
        f"eum/v1/prop-fund/{ACCOUNT_ID}/lockout"
    )
    print("Authorized TradeSea account selected from the web app")

    ws = websocket.WebSocketApp(
    WS_URL,
    cookie=f"access_token={ACCESS_TOKEN}",
    header=[
        "Origin: https://app.tradesea.ai"
    ],
    on_open=on_open,
    on_message=on_message,
    on_error=on_error,
    on_close=on_close
)


    ws.run_forever()
