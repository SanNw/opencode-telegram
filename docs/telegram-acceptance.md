# Physical Telegram acceptance

This checklist is deliberately not marked passed by server health, unit tests or browser emulation. Record the Telegram version, OS, device, date and actual result for each client. Use a disposable session for mutations and retain the independent Recovery Key outside Telegram.

| Scenario | Android | Desktop | Expected result |
| --- | --- | --- | --- |
| Open from the bot with a trusted device | Pending | Pending | Signed Telegram session validates and existing project loads. |
| Show/hide keyboard, rotate/resize, long chat | Pending | Pending | Composer remains reachable; chat scrolls; navigation does not require scrolling to page bottom. |
| Background and resume during streaming | Pending | Pending | Current messages reconcile without duplicate/empty bubbles. |
| Disconnect/reconnect network | Pending | Pending | Offline state is honest; reconnect loads current state without replaying mutations. |
| Expired normal session | Pending | Pending | Authentication gate appears; no protected data remains usable. |
| Revoke another test device | Pending | Pending | Its active stream and subsequent requests stop; the surviving device remains usable. |
| Recovery Key setup | Pending | Pending | Key is revealed once in a blocking dialog; save confirmation is required before leaving. |
| Step-up and five-minute expiration | Pending | Pending | Sensitive action requires elevation again after expiration; ordinary reading still works. |
| Emergency lock / compromised Telegram | Pending | Pending | Confirmed lock is shown; sessions are revoked and pending approvals cannot execute. |
| Independent recovery on a fresh device | Pending | Pending | Recovery works with valid key and fresh device proof without trusting Telegram identity. Old devices stay revoked. |
| Provider connect and switch provider | Pending | Pending | Password does not carry to another provider; approval summary contains no key. |
| Opaque artifact and HTML preview | Pending | Pending | Authorized attachment opens; scripts and external resources remain blocked in HTML preview. |
| Approved Git action on disposable repository | Pending | Pending | Explicit approval/elevation required; only selected commit paths or validated upstream branch are affected. |

Never test emergency lock without first saving the key and having access to the local installation. Do not use production repositories for destructive experimentation. A failed upstream abort must be recorded separately from the successful access lock.

## Recording an acceptance run

Create a separate dated report with device/OS, Telegram version, application commit and each result (`Pass`, `Fail` or `Not tested`). Do not put Recovery Keys, pairing codes, tokens or signed Telegram initialization into the report or screenshots. Mark the table above only from actual-client evidence, never from the mock browser suite.

Start with the non-destructive scenarios: opening from the bot, navigation, keyboard, rotation/resize, long response, background/resume and network reconnection. Save evidence of any overflow, duplicate message, empty bubble or inaccessible composer. Security mutations should be tested afterward on a disposable isolated installation with a saved Recovery Key and local administrative access.

The automated companion is documented in `browser-validation.md`. Its 401/403 and clock simulation check frontend behavior but do not substitute for the physical matrix.
