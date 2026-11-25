#!/bin/sh
set -eu

relay_key=$1
bootstrap_key=$2
case "$relay_key" in 'ssh-ed25519 '*) ;; *) exit 2 ;; esac
case "$bootstrap_key" in 'ssh-ed25519 '*) ;; *) exit 2 ;; esac

cloud-init status --wait
bridge=$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}')
case "$bridge" in ''|*[!0-9.]*) echo 'Docker bridge address is unavailable.' >&2; exit 1 ;; esac

if ! id qos-tunnel >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /home/qos-tunnel --shell /usr/sbin/nologin qos-tunnel
fi
install -d -m 0700 -o qos-tunnel -g qos-tunnel /home/qos-tunnel/.ssh
relay_keys=/home/qos-tunnel/.ssh/authorized_keys
printf 'restrict,port-forwarding,permitlisten="%s:38443" %s\n' "$bridge" "$relay_key" > "$relay_keys"
chmod 0600 "$relay_keys"
chown qos-tunnel:qos-tunnel "$relay_keys"

cat > /etc/ssh/sshd_config.d/55-qos-tunnel.conf <<EOF
Match User qos-tunnel
    AuthenticationMethods publickey
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    AllowTcpForwarding remote
    GatewayPorts clientspecified
    PermitListen $bridge:38443
    PermitTTY no
    ForceCommand /usr/sbin/nologin
Match all
EOF

install -d -m 0700 -o ec2-user -g ec2-user /home/ec2-user/.ssh
bootstrap_keys=/home/ec2-user/.ssh/authorized_keys
touch "$bootstrap_keys"
if ! grep -Fq "$bootstrap_key" "$bootstrap_keys"; then
  printf 'restrict %s\n' "$bootstrap_key" >> "$bootstrap_keys"
fi
chmod 0600 "$bootstrap_keys"
chown ec2-user:ec2-user "$bootstrap_keys"
if command -v restorecon >/dev/null 2>&1; then
  restorecon -R /home/qos-tunnel/.ssh /home/ec2-user/.ssh
fi

sshd -t
systemctl enable --now sshd
systemctl reload sshd
printf 'BRIDGE=%s\n' "$bridge"
printf 'HOST_KEY='
awk '{print $1, $2}' /etc/ssh/ssh_host_ed25519_key.pub
