"""Bootstrap or verify the persistent TradeSea browser login."""

import argparse
from datetime import datetime

from tradesea_auth import get_access_token


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--headless",
        action="store_true",
        help="reuse an existing login without showing Chrome",
    )
    args = parser.parse_args()

    token = get_access_token(headless=args.headless)
    print(f"TradeSea access token is available ({len(token)} characters) at {datetime.now():%H:%M:%S}.")


if __name__ == "__main__":
    main()
