# mse-history-fallback

Fills `_securitytradingstatus_history` from MSE's live datafeed (`security_trading`) when the server-side feed missed
rows. MSE answers only from allowlisted IPs and production's IP cannot be added, so this runs as a one-shot script on a
separate always-on machine that MSE accepts, and writes straight into production MySQL over the network. Nothing needs
to change on the production server. It was split out of the bds_back_v2 backend and has no dependency on it.
(`src/historyWriteLock.js` is kept as reviewed; it only guards this process and protects nothing across processes.)

## Setup (once, on the runner)

1. Install Node >= 18 and git. Clone this repo (for example to `C:\mse-history-fallback`) and run `npm ci`.
2. `copy .env.example .env` (Linux: `cp`) and fill it in. `.env` is git-ignored and holds real secrets: keep it that way.
   `DB_TIMEZONE=+08:00` must match production. Take the SMTP lines from production so the alert goes through the same relay.
3. On production MySQL, as an admin, by hand (not through the app):

```sql
CREATE USER 'mse_fallback'@'<runner IP>' IDENTIFIED BY '<strong password>';
GRANT SELECT, INSERT, UPDATE ON <database>.`_securitytradingstatus_history` TO 'mse_fallback'@'<runner IP>';
```

   Port 3306 must be open from the runner to production (allowlist the runner IP only).
4. Run `SHOW CREATE TABLE _securitytradingstatus_history` on production and compare it with
   `src/models/_securitytradingstatus_history.js` (dry run does not exercise the write path).

## Dry run first

`npm run dry-run` on a trading day after 16:20. It prints a summary line and one line per row it would insert or update,
writes nothing and sends no mail. Compare with the feed's table. When one day looks right, schedule the real run.

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
