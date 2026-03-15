import subprocess
import json
import os
import tempfile
from flask import Flask, jsonify, request
from flask_cors import CORS
import re

app = Flask(__name__)
CORS(app)



@app.route("/api/discovery/run", methods=["POST"])
def run_discovery():
    body = request.get_json()
    user_topic = body.get("message", "Islamic finance in media")

    prompt1 = f"""Find 20-25 Muslim-themed movies, TV series, YouTube shows and documentaries related to: {user_topic}

List each one with: title, type, year, description, language, and relevance to Islamic finance (high/medium/low/none)."""

    # Write first prompt to temp file
    with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False, encoding='utf-8') as f:
        f.write(prompt1)
        temp1 = f.name

    result1 = subprocess.run(
        ["claude.cmd", "-p", f"@{temp1}", "--output-format", "text"],
        capture_output=True,
        text=True
    )
    os.unlink(temp1)

    print("=== FIRST CALL OUTPUT ===")
    print(result1.stdout[:500])
    print("=== END ===")

    if result1.returncode != 0:
        return jsonify({"error": result1.stderr}), 500

    raw = result1.stdout

    # Try direct JSON extraction first
    match = re.search(r'\[.*\]', raw, re.DOTALL)
    if match:
        return jsonify({"text": match.group(0)})

    # Second call to convert markdown to JSON
    prompt2 = f"""Convert this list into a JSON array. Return ONLY the JSON array starting with [ and ending with ]. No explanation, no markdown.

Each item must have these exact fields:
title_en (string), title_ar (string or null), title_ur (string or null), title_tr (string or null), type (movie/tv_series/youtube_show/documentary/unknown), language (string), year (number or null), description (string), tags (array of strings), source_urls (empty array []), islamic_finance_relevance (high/medium/low/none), notes (string)

Here is the list:

{raw}"""

    with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False, encoding='utf-8') as f:
        f.write(prompt2)
        temp2 = f.name

    result2 = subprocess.run(
        ["claude.cmd", "-p", f"@{temp2}", "--output-format", "text"],
        capture_output=True,
        text=True
    )
    os.unlink(temp2)

    print("=== SECOND CALL OUTPUT ===")
    print(result2.stdout[:500])
    print("=== END ===")

    match2 = re.search(r'\[.*\]', result2.stdout, re.DOTALL)
    if not match2:
        return jsonify({"error": "Could not parse response", "raw": result2.stdout}), 500

    return jsonify({"text": match2.group(0)})




@app.route("/api/library", methods=["GET"])
def get_library():
    if not os.path.exists("data.json"):
        return jsonify([])
    with open("data.json", "r") as f:
        return jsonify(json.load(f))

if __name__ == "__main__":
    app.run(port=5000, debug=True)