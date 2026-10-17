# Corridor (web)

Interest-based doors. Each door has a live queue. Two people inside get paired for a timed text chat. Skip, keep talking, report. Keyword moderation.

## Run
    npm install
    ADMIN_KEY=choose-a-key INVITE_CODE=du2026 npm start     # http://localhost:3000, admin at /admin

Env: PORT, ROUND_SECONDS (180), EXTEND_SECONDS (180), INVITE_CODE (optional gate), ADMIN_KEY, DATA_DIR (bans/reports, default ./var), IP_SALT, KEYWORDS_FILE.
Needs a host with WebSockets and a persistent disk (Render, Railway, Fly, a VPS). Firebase Hosting alone will not run it.

## How it works
- Door -> queue. Oldest two eligible people pair. Same pair is not re-matched for 30 min; reported pairs never.
- Round timer. When both tap "Keep talking", time is added. Skip sends you straight back into the same door.
- Report: reason + last 30 messages saved for review, pair blocked, reporter removed. 3 distinct reporters in 24h = auto 24h ban.
- Moderation: data/keywords.json (block / mask / care). Edit live in /admin. 3 blocked messages in a round = removed + 10 min break.
- Phone numbers, links, emails, Instagram/Snap handles are hidden (toggle in /admin).
- Chats are never stored unless reported. Blocked messages log only the matched term.

## Files
server.js, lib/moderation.js, lib/store.js, data/doors.json (doors + icebreakers), data/keywords.json, public/index.html, public/admin.html
Tests: `npm test`

## Known limits
- Identity is a browser id + invite code. Clearing storage evades bans. Plug real Unrest/DU login into onHello() in server.js.
- Single process, in-memory queues. Fine for hundreds of users. Scaling out needs Redis.
- A dropped connection ends the chat (no reconnect grace).
- Starter keyword list is basic. Add campus slang and Hinglish terms in /admin.
