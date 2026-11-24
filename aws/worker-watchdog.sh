#!/bin/sh
set -eu

boot_seconds=$(cut -d . -f 1 /proc/uptime)
[ "$boot_seconds" -gt 150 ] || exit 0
contact=/run/qos-worker/contact/last
if [ -f "$contact" ]; then
  now=$(date +%s)
  modified=$(stat -c %Y "$contact")
  [ "$((now - modified))" -gt 35 ] || exit 0
fi

logger -t qos-worker 'Controller contact expired. Stopping the EC2 host.'
systemctl poweroff
