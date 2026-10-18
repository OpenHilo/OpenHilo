#!/usr/bin/env python3
"""ITT Python subprocess runner.

Environment variables:
  _ITT_INPUT         — path to JSON file with pre-injected globals
                       (keys are bare variable names, e.g. {"count": 5})
  _ITT_SCRIPT_FILE   — path to file containing the user script
  _ITT_OUTPUT        — path where output JSON will be written
  _ITT_DECLARED_KEYS — JSON array of declared output key names (without ITT_ prefix)

Output JSON format:
  { "outputs": { "key": <value> }, "not_serialisable": ["other_key"] }
"""

import json
import os
import sys


def main() -> None:
    input_path = os.environ["_ITT_INPUT"]
    script_file = os.environ["_ITT_SCRIPT_FILE"]
    output_path = os.environ["_ITT_OUTPUT"]
    declared_keys: list = json.loads(os.environ.get("_ITT_DECLARED_KEYS", "[]"))

    with open(input_path, encoding="utf-8") as f:
        globals_dict: dict = json.load(f)

    with open(script_file, encoding="utf-8") as f:
        user_script = f.read()

    exit_code = 0
    try:
        exec(user_script, globals_dict)  # noqa: S102
    except SystemExit as exc:
        exit_code = exc.code if isinstance(exc.code, int) else (0 if exc.code is None else 1)
        if exc.code is not None and not isinstance(exc.code, int):
            print(exc.code, file=sys.stderr)

    outputs: dict = {}
    not_serialisable: list = []

    for key in declared_keys:
        var_name = key
        if var_name not in globals_dict:
            continue  # absent — scheduler will detect as "not set"
        val = globals_dict[var_name]
        try:
            json.dumps(val)  # serialisability probe
            outputs[key] = val
        except (TypeError, ValueError):
            not_serialisable.append(key)

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump({"outputs": outputs, "not_serialisable": not_serialisable}, f)
    raise SystemExit(exit_code)


if __name__ == "__main__":
    main()
