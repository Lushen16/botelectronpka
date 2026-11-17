"""Compare the telemetry decoder's expected fields with the live payload dump.

Reports which decoder fields appear as JSON literals in the captured native
module dump, and which fields the module emits that the decoder ignores. This
is a coverage check over captured bytes; it does not prove runtime behaviour.

Usage:
  python tools/audit_telemetry_fields.py --dump captures/keydump/payload-full.bin
"""
from __future__ import annotations

import argparse
import re
import sys

DECODER_FIELDS = """
schema nativeVerified pulseVersion tick playerId fightMode chaseMode clockMs
activeSlot position moves nativeSequence pokemonName comboPokemonName
conditionEvents conditionsKnown conditions roster creatures items tiles
pinnedTexts alertEvents clientPid playerName ownSummonId direction guildDailies
guildName guildDailyAvailable guildDailyAutoVersion combatDispatchVersion
dynamicLureVersion
""".split()

JSON_LITERAL = re.compile(rb'"([A-Za-z][A-Za-z0-9_]{1,48})"\s*:')


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dump", required=True)
    args = parser.parse_args()

    with open(args.dump, "rb") as fh:
        data = fh.read()
    emitted = {match.group(1).decode("ascii") for match in JSON_LITERAL.finditer(data)}

    decoder = set(DECODER_FIELDS)
    covered = sorted(decoder & emitted)
    unseen = sorted(decoder - emitted)
    extra = sorted(emitted - decoder)

    print("dump=%s bytes=%d" % (args.dump, len(data)))
    print("json_literals=%d" % len(emitted))
    print("decoder_fields=%d" % len(decoder))
    print()
    print("decoder fields present in the dump (%d):" % len(covered))
    print("  " + ", ".join(covered))
    print()
    print("decoder fields NOT found in this dump (%d):" % len(unseen))
    print("  " + ", ".join(unseen))
    print()
    print("dump literals the decoder does not model (%d):" % len(extra))
    print("  " + ", ".join(extra[:80]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
