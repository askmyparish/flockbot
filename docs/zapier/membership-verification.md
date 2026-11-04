# Restricted membership test

This separate private candidate tests one configured fictional person in one
allowlisted test-parish group. The normal integration's membership gate remains
blocked. This exception does not establish durable session storage, coordination,
production readiness or distributed exactly-once execution.

Prepare a private, owner-readable JSON plan outside the checkout:

```json
{
  "consent": "authorize-restricted-membership-build",
  "subdomain": "example-parish",
  "networkId": "201",
  "groupId": "102",
  "testEmail": "controlled@example.test",
  "testOnlyLoginConfirmed": true,
  "fictionalRecordConfirmed": true
}
```

Use independently known network/group IDs and a controlled email. The login must
have access only to this test parish. Never include credentials in this plan.
On Node 22, run `node scripts/zapier/build-membership-verification.mjs --private-plan-file <private-file>`.
This offline command creates a separate temporary package, version 2.0.1, with a
30-minute window starting at build time. Its deployment configuration contains
the exact origin/network/group and an email digest; it contains no password,
cookie or recipient email. The digest is private configuration too: do not
publish the artifact. Build the final package immediately before the approved
private upload. Inspect both CLI ZIPs and use an external deploy-key file.

After independent review and authorized private upload, select **Add One
Configured Test Member** in an unpublished test Zap. Use a new protected
connection with the restricted login and the approved controlled email. The
protected `testEmail` field must match the deployment plan. The person has fixed
fictional names, Flockbot Verification. The action accepts only explicit consent
`authorize-one-test-member`; it accepts no target or member override.

Manually test the action once. Do not publish an automatic trigger, enable replay
or invoke it concurrently. The source permits one membership POST per invocation,
not one globally: another invocation would be another upstream attempt. No repeat
is authorized by this procedure. A fresh saved session must already exist; the
action has no credential provider and cannot request host refresh or log in.

The action uses one shared client to verify authentication with `user/userData`,
read `network/getMetadata`, compare its `networkID` with the independently
configured ID, discover the group, and add the member. Metadata alone does not
prove authentication. A missing or unexpected metadata `networkID` stops before
the add. A fixed stage name identifies which pre-submission check stopped.
Reads and the add share a 20-second deadline, a maximum of eight requests and
zero retries. Expiration also stops later requests. Cookie changes remain local
to this invocation and are not represented as durable host updates.

A confirmed response returns only `{ "success": true }`. Inspect membership and
notification effects privately in Flocknote. Any failure after possible submission
uses `HaltedError` with a fixed code and instructs manual inspection. A timeout
cannot show that no membership was created. Actual host replay/notification
semantics remain unproven, so keep the test unpublished and never repeat an
unknown result. Remove the private configuration after the session; the deployed
candidate stops accepting requests when its short window expires.
