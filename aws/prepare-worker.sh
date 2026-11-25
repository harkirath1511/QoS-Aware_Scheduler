#!/bin/sh
set -eu

. /etc/qos-worker/host.env
. /etc/qos-worker/worker.env

case "$WORKER_IMAGE" in
  *@"$WORKER_IMAGE_DIGEST") ;;
  *) echo 'WORKER_IMAGE must end in the configured image digest.' >&2; exit 1 ;;
esac
docker image inspect "$WORKER_IMAGE" >/dev/null

install -d -o root -g root -m 0755 /run/qos-worker/identity
install -d -o 1000 -g 1000 -m 0700 /run/qos-worker/contact
if [ -f /etc/qos-worker/relay.pem ]; then
  install -m 0444 /etc/qos-worker/relay.pem /run/qos-worker/identity/relay.pem
fi
metadata='http://169.254.169.254/latest'
token=$(curl --fail --silent --show-error --max-time 5 -X PUT "$metadata/api/token" \
  -H 'X-aws-ec2-metadata-token-ttl-seconds: 120')
for field in document signature; do
  curl --fail --silent --show-error --max-time 5 \
    -H "X-aws-ec2-metadata-token: $token" "$metadata/dynamic/instance-identity/$field" \
    -o "/run/qos-worker/identity/$field"
  chmod 0444 "/run/qos-worker/identity/$field"
done
