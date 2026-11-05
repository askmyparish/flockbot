---
"@askmyparish/flockbot-mcp": patch
---

Keep the sign-in tool active briefly while browser login finishes, then prompt the assistant to continue the original request without a separate “I’m signed in” message. Preserve a bounded pending/cancellation fallback and the existing browser connection; never automatically replay a write with an unknown outcome.
