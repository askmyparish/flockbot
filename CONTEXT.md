# Flocknote parish integration

Flockbot connects parish workflows to Flocknote. These terms describe parish networks and their members independently of any particular deployment.

## Language

**Parish network**:
A parish's space in Flocknote, containing its members and groups. A parish network is distinct from a person's Flocknote login.
_Avoid_: Account when referring to the parish's space

**Flocknote login**:
The identity and credentials a person uses to authenticate with Flocknote. Its permissions determine which parish information and actions are available.
_Avoid_: Parish account when referring to a person's identity

**Flockbot connection**:
A saved association between a parish network and the Flocknote login an integration uses. Its Flocknote session can be renewed without changing the configured parish or login.
_Avoid_: Account when referring to an integration's saved connection

**Local Flockbot connection**:
A Flockbot connection belonging to one operating-system user on one computer. That user's assistant applications share the connection; another operating-system user has a separate connection.
_Avoid_: Computer-wide account when referring to a local user's connection

**Local Flocknote browser profile**:
A dedicated browser profile belonging to one local Flockbot connection. The browser
retains authentication state and performs the connector's internal API requests.
It is separate from the user's everyday browser and from an assistant's plugin
installation. Sign-in happens on Flocknote's own website.

**Flocknote session**:
An established authenticated interaction with Flocknote that can be reused until Flocknote no longer accepts it. Reusing a session is distinct from logging in again.

**Password login**:
Authentication using a Flocknote login's password. An authentication email sent during login does not necessarily mean a code must be entered.

**Code login**:
Authentication using a one-time code received through a channel registered with Flocknote.
_Avoid_: Password reset when referring to a one-time login code

**Group**:
A named collection of members within a parish network to which communications can be addressed.

**Latest group email**:
The email with the newest original send time for a group. Resending an older email does not make it latest, and selection does not depend on whether a particular user was a recipient.

**Email aggregate analytics**:
Flocknote's reported counts for an email across its tracking categories. These categories do not establish delivery or human reading, need not be mutually exclusive, and are not attributed to an individual resend attempt.

**User**:
A person associated with, or intended to join, a Flocknote parish network, distinct from the Flocknote login used to authenticate an integration. Supplied contact details alone do not establish that an existing parish record has been identified or created.
_Avoid_: Login or account when referring to the person represented in parish records

**Group membership**:
A relationship linking a user to a particular Flocknote group, with preferences and roles when established. A requested membership remains an intent until Flocknote confirms the addition.
_Avoid_: Group participation when describing the domain concept

**Test parish**:
A Flocknote parish network reserved for verifying integration behavior with test records, separate from networks used for real parish work.
_Avoid_: Fake account when referring to the test parish network

**Active parish network**:
A Flocknote parish network used for real parish communication and membership workflows. It is distinct from a test parish.
