#!/usr/bin/env bash
pkill -f src/partners.js 2>/dev/null && echo "Stopped partners." || echo "Partners were not running."
pkill -f src/app.js      2>/dev/null && echo "Stopped app."      || echo "App was not running."
docker stop skyward-db   >/dev/null 2>&1 && echo "Stopped Postgres." || echo "Postgres was not running."
