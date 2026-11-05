// Consumer-side type coverage through the package's actual root exports map.
import type {
  Group,
  MembershipExecutor,
  MembershipRequest,
  ResourceRead,
} from "@askmyparish/flockbot";

export const resources: ResourceRead = {
  read: async () => ({}),
  check: () => {},
};
export const membership: MembershipRequest = {
  path: "group/101/addToGroupByAdmin",
  body: "",
};
export const execute: MembershipExecutor = async (_request, parse) =>
  parse({ success: true });
export function addToGroup(group: Group) {
  return group.addMember({
    firstName: "Alex",
    lastName: "Rivera",
    email: "alex@example.test",
  });
}
