# Flocknote parish integration

Flockbot connects parish workflows to Flocknote. These terms describe parish networks and their members independently of any particular deployment.

## Language

**Parish network**:
A parish's space in Flocknote, containing its members and groups. A parish network is distinct from a person's Flocknote login.
_Avoid_: Account when referring to the parish's space

**Flocknote login**:
The identity and credentials a person uses to authenticate with Flocknote. Its permissions determine which parish information and actions are available.
_Avoid_: Parish account when referring to a person's identity

**Flocknote session**:
An established authenticated interaction with Flocknote that can be reused until Flocknote no longer accepts it. Reusing a session is distinct from logging in again.

**Password login**:
Authentication using a Flocknote login's password. An authentication email sent during login does not necessarily mean a code must be entered.

**Code login**:
Authentication using a one-time code received through a channel registered with Flocknote.
_Avoid_: Password reset when referring to a one-time login code

**Group**:
A named collection of members within a parish network to which communications can be addressed.

**Group membership**:
A member's inclusion in a particular Flocknote group.
_Avoid_: Group participation when describing the domain concept

**Test parish**:
A Flocknote parish network reserved for verifying integration behavior with test records, separate from networks used for real parish work.
_Avoid_: Fake account when referring to the test parish network

**Active parish network**:
A Flocknote parish network used for real parish communication and membership workflows. It is distinct from a test parish.
