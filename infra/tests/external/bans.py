#!/usr/bin/env python3
"""US-04 fail2ban ban assertions on the live edge (02-TRD s6.8): AC-04.4, AC-04.4a, AC-04.5, AC-04.7 (and AC-04.6's flood guard).

Each scenario runs from its own source address (LIMS_TEST_SOURCE_IPS, comma-separated local addresses to bind, >= 5), with the
jails ENABLED (08 A27.2). The bans are read with `fail2ban-client` on the edge host: LIMS_F2B_CMD is the command prefix,
e.g. `ssh ops@<wg-ip> sudo fail2ban-client` (split with shlex). Every ban this script causes is removed again (unbanip).
Env: LIMS_ORIGIN_API (required), LIMS_ORIGIN_STAFF_WEB (required), LIMS_EDGE_ADDR, LIMS_TLS_CA or LIMS_TLS_INSECURE=1,
LIMS_F2B_WAIT (seconds to wait for a ban, default 90). Nothing is sent unless every required variable is set (exit 2).
Scenarios (all counts are limit_req rejections, i.e. 429s from the edge):
  AC-04.4   one IP, > 20 rejections outside login/agent/otp/psession (GET /v1/payments/result) -> banned by lims-ratelimit
  AC-04.4a  one IP, two 501-request bursts at /v1/instruments/agent/ -> not banned by any jail
  AC-04.5   one IP, 330 POST /auth/login at once (~310 rejected) -> banned by lims-auth; a 41-request burst (21 rejected) -> not
  AC-04.7   one IP, 30 GET of unknown paths under /v1/instruments/agent/ -> not banned by any jail
"""
import os
import shlex
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
JAILS = ("lims-ratelimit", "lims-auth", "sshd")


def need_env():
    o = {k: os.environ.get("LIMS_ORIGIN_" + k.upper(), "") for k in ("staff_web", "api")}
    cmd = shlex.split(os.environ.get("LIMS_F2B_CMD", ""))
    ips = [x.strip() for x in os.environ.get("LIMS_TEST_SOURCE_IPS", "").split(",") if x.strip()]
    if not all(o.values()) or not cmd or len(ips) < 5:
        sys.stderr.write("bans.py: set LIMS_ORIGIN_STAFF_WEB, LIMS_ORIGIN_API, LIMS_F2B_CMD and >= 5 LIMS_TEST_SOURCE_IPS\n")
        sys.exit(2)
    return o, cmd, ips


def banned(cmd, jail):
    r = subprocess.run(cmd + ["status", jail], capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise RuntimeError("fail2ban-client status %s: %s" % (jail, r.stderr.strip()))
    for line in r.stdout.splitlines():
        if "Banned IP list" in line:
            return line.split(":", 1)[1].split()
    return []


def wait_ban(cmd, jail, ip, wait):
    end = time.time() + wait
    while time.time() < end:
        if ip in banned(cmd, jail):
            return True
        time.sleep(3)
    return False


def main():
    o, cmd, ips = need_env()
    import ratelimit as rl   # same directory: req(), burst(), Run

    wait = int(os.environ.get("LIMS_F2B_WAIT", "90"))
    t = rl.Run()
    ip_ban, ip_agent, ip_login, ip_login_low, ip_404 = ips[:5]
    try:
        # AC-04.4: > 20 rejections of the payments zone (10 r/s burst 20) from one IP
        for _ in range(3):
            rl.burst(o["api"], "GET", "/v1/payments/result", 81, ip_ban)
            time.sleep(1)
        t.check(wait_ban(cmd, "lims-ratelimit", ip_ban, wait), "AC-04.4 20+ rejections -> banned by lims-ratelimit")
        t.check(ip_ban not in banned(cmd, "lims-auth"), "AC-04.4 not in lims-auth")

        # AC-04.4a: 501-request agent bursts, twice
        for _ in range(2):
            rl.burst(o["api"], "POST", "/v1/instruments/agent/heartbeats", 501, ip_agent)
            time.sleep(2)
        time.sleep(min(wait, 45))
        t.check(all(ip_agent not in banned(cmd, j) for j in JAILS), "AC-04.4a 2 x 501 agent requests -> no jail bans the IP")

        # AC-04.5 negative then positive (different addresses so one ban cannot hide the other)
        rl.burst(o["staff_web"], "POST", "/auth/login", 41, ip_login_low)
        time.sleep(min(wait, 45))
        t.check(all(ip_login_low not in banned(cmd, j) for j in JAILS), "AC-04.5 21 login rejections -> no ban")
        rl.burst(o["staff_web"], "POST", "/auth/login", 330, ip_login)
        t.check(wait_ban(cmd, "lims-auth", ip_login, wait), "AC-04.5 300+ login rejections -> banned by lims-auth")
        t.check(ip_login not in banned(cmd, "lims-ratelimit"), "AC-04.5 login rejections do not trip lims-ratelimit")

        # AC-04.7: 30 unknown agent paths
        for i in range(30):
            rl.req(o["api"], "GET", "/v1/instruments/agent/no-such-%d" % i, ip_404)
        time.sleep(min(wait, 45))
        t.check(all(ip_404 not in banned(cmd, j) for j in JAILS), "AC-04.7 30 agent 404s -> no ban")
    finally:
        for j in JAILS:
            for ip in ips[:5]:
                subprocess.run(cmd + ["set", j, "unbanip", ip], capture_output=True, text=True, timeout=60)
    print("bans: %d failure(s)" % len(t.fails))
    return 1 if t.fails else 0


if __name__ == "__main__":
    sys.exit(main())
