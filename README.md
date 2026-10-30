# mse-history-fallback

Fills `_securitytradingstatus_history` from MSE's live datafeed (`security_trading`) when the server-side feed missed
rows. MSE answers only from allowlisted IPs and production's IP cannot be added, so this runs as a one-shot script on a
separate always-on machine that MSE accepts, and writes into production MySQL through an SSH tunnel. Nothing needs
to change on the production server except one MySQL user. It was split out of the bds_back_v2 backend and has no dependency on it.
(`src/historyWriteLock.js` is kept as reviewed; it only guards this process and protects nothing across processes.)

## Setup (once, on the runner)

1. Install Node >= 18 and git. Clone this repo (for example to `C:\mse-history-fallback`) and run `npm ci`.
2. `copy .env.example .env` (Linux: `cp`) and fill it in. `.env` is git-ignored and holds real secrets: keep it that way.
   `DB_TIMEZONE=+08:00` must match production. Take the SMTP lines from production so the alert goes through the same relay.
3. Network: an SSH tunnel to production, the same way MySQL Workbench connects ("Standard TCP/IP over SSH"). The script
   opens it itself on every run, from `.env`; there is nothing to install or keep running. Production's MySQL listens on
   localhost only and stays that way; nothing on production changes except one MySQL user (step 4).
   - Set `SSH_HOST` (production's address, for example its Tailscale 100.68.x.x), `SSH_USERNAME` and `SSH_PASSWORD`
     (the same login Workbench uses), and `DB_HOST=127.0.0.1` with `DB_PORT=13306` (the local end of the tunnel,
     any free port). Optional: `SSH_PORT` (22) and `SSH_REMOTE_PORT` (3306, MySQL's port on production).
   - Leave `SSH_HOST` out and the script connects to `DB_HOST:DB_PORT` directly instead.
   - SSH login and the tunnel are checked at run time: a wrong password or an unreachable host fails the run with exit 1
     and a "run crashed" mail naming only `SshTunnelError` and a code (`client-authentication`, `ECONNREFUSED`,
     `client-timeout`). A missing `SSH_USERNAME` / `SSH_PASSWORD` exits 2.
   - Check MSE's login answers 200 from the runner (a 401/403/timeout means the call left from an IP MSE does not allow).
4. On production MySQL, as an admin, by hand (not through the app). Connections arrive through the tunnel from
   localhost, so the user is for `localhost` (and `127.0.0.1`, in case name resolution is off):

```sql
CREATE USER 'mse_fallback'@'localhost' IDENTIFIED BY '<strong password>';
CREATE USER 'mse_fallback'@'127.0.0.1' IDENTIFIED BY '<strong password>';
GRANT SELECT, INSERT, UPDATE ON <database>.`_securitytradingstatus_history` TO 'mse_fallback'@'localhost';
GRANT SELECT, INSERT, UPDATE ON <database>.`_securitytradingstatus_history` TO 'mse_fallback'@'127.0.0.1';
```

5. Run `SHOW CREATE TABLE _securitytradingstatus_history` on production and compare it with
   `src/models/_securitytradingstatus_history.js` (dry run does not exercise the write path).

## Dry run first

`npm run dry-run` on a trading day after 16:20. It prints a summary line and one line per row it would insert or update,
writes nothing and sends no mail. Compare with the feed's table. When one day looks right, schedule the real run.

## Backfill past days

The scheduled run only repairs today. For days that already passed (a frozen feed, a missed run) use the backfill, which
reads MSE's finished-day call (`security_trading_history?date=`) and applies the same rules:

```
npm run backfill -- --from 2026-10-21 --to 2026-10-22 --dry-run
npm run backfill -- --from 2026-10-21 --to 2026-10-22
```

- Dry run first: it prints what it would insert or update per day and writes nothing. Then run without `--dry-run`.
- Weekdays only, oldest first, one MSE call per day; MSE allows one per 120 s, so each day takes about two minutes.
- `--to` is optional (one day). Today and the future are refused; the scheduled run does today.
- No alert mail; the log shows one summary line per day. Exit 1 if any day failed (MSE unreachable, write failed).
- Safe to repeat: rows already stored with the same volume are left alone.

## Schedule (16:20 and 21:20 Ulaanbaatar time, Monday to Friday)

The machine clock must be Ulaanbaatar time, or shift the times.

Windows (two tasks):

```
schtasks /Create /TN "mse-fallback-1620" /SC WEEKLY /D MON,TUE,WED,THU,FRI /ST 16:20 /TR "cmd /c cd /d C:\mse-history-fallback && node src\run.js >> C:\mse-history-fallback\run.log 2>&1"
schtasks /Create /TN "mse-fallback-2120" /SC WEEKLY /D MON,TUE,WED,THU,FRI /ST 21:20 /TR "cmd /c cd /d C:\mse-history-fallback && node src\run.js >> C:\mse-history-fallback\run.log 2>&1"
```

Linux (crontab, machine on Asia/Ulaanbaatar time):

```
20 16,21 * * 1-5 cd /opt/mse-history-fallback && node src/run.js >> /var/log/mse-fallback.log 2>&1
```

## Exit codes

- 0: ran fine (healthy, repaired, flagged, dry run, non-trading day)
- 1: MSE unreachable, the DB write failed, or the run crashed
- 2: MSE login or a required database variable is not set (the log line names the variable, never a value)

## What you will see

- One log line per run: `mse-history-fallback <date> status=... inserts=N updates=N ...`.
- Mail to `MSE_FALLBACK_ALERT_EMAIL` (default it@bdsec.mn) only when it repaired something, flagged something odd, could
  not reach MSE, failed to write, or crashed (for example MySQL unreachable from here; the mail carries only the error
  name and code). The mailer logs nothing.
- Known: bonds with an empty MarketSegmentID (for example SHKH) are inserted with `N/A` and trigger a "repaired" mail on
  days they trade, until the owner decides what to do about them.

## Limits

- Two processes cannot share the in-process lock. The script re-reads the table right before writing, so the window for
  a duplicate row against production's own writer is milliseconds, and its 16:16 and 21:16 passes finish before 16:20
  and 21:20. The table has no unique index, so a duplicate would not be rejected; the next summary reports it.
- MSE allows 1 request per endpoint per 120 s. Do not run it by hand within two minutes of a scheduled run.
- Rotate the MSE, DB and SMTP passwords here as you do on production.

## Tests

`npm test` runs every `test/*.test.js` (plain assert, no network, no database).
