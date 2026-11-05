import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  FlockbotError,
  FlocknoteLogin,
  GroupMembership,
  Network,
  User,
} from "../../src/index.js";

describe("shared resource models", () => {
  it("sanitizes failures while snapshotting caller-supplied contact fields", () => {
    const input = {
      firstName: "Alex",
      lastName: "Rivera",
      get email(): string {
        throw new Error("private-contact@example.test");
      },
    };
    try {
      new User(input);
      throw new Error("Expected invalid contact input");
    } catch (error) {
      expect(error).toMatchObject({
        code: "invalid_input",
        outcome: "not_submitted",
      });
      expect(String(error)).not.toContain("private-contact@example.test");
    }
  });
  it("snapshots validated contact input and keeps it out of default serialization", () => {
    const input = {
      firstName: " Alex ",
      lastName: " Rivera ",
      email: " alex@example.test ",
    };
    const user = new User(input);
    const membership = new GroupMembership("00102", user);
    input.email = "changed@example.test";
    expect(user.firstName).toBe("Alex");
    expect(membership.groupId).toBe("102");
    expect(new URLSearchParams(membership.request().body).get("email")).toBe(
      "alex@example.test",
    );
    expect(Object.isFrozen(user)).toBe(true);
    expect({ ...user }).toEqual({});
    expect(Object.entries(user)).toEqual([]);
    expect(user.email).toBe("alex@example.test");
    expect(JSON.stringify([user, membership])).not.toContain(
      "alex@example.test",
    );
    expect(inspect([user, membership])).not.toContain("alex@example.test");
  });

  it("submits a membership exactly once and preserves the executor's uncertain result", async () => {
    const membership = new GroupMembership(
      "102",
      new User({
        firstName: "Alex",
        lastName: "Rivera",
        email: "alex@example.test",
      }),
    );
    const failure = new FlockbotError("transport_failed", undefined, "unknown");
    const execute = vi.fn(async () => {
      throw failure;
    });
    await expect(membership.add(execute)).rejects.toBe(failure);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("keeps sign-in identity distinct from a parish contact snapshot", () => {
    const login = FlocknoteLogin.fromResponse({
      success: true,
      userID: 201,
      email: "private@example.test",
    });
    expect(login.id).toBe("201");
    expect(JSON.stringify(login)).not.toContain("private@example.test");
    expect(() =>
      FlocknoteLogin.fromResponse(
        new User({
          firstName: "Alex",
          lastName: "Rivera",
          email: "alex@example.test",
        }),
      ),
    ).toThrow(FlockbotError);
  });

  it("refuses ambiguous case-insensitive names even when one spelling is exact", async () => {
    const network = new Network("example-parish");
    const read = async (path: string) =>
      path === "dashboard"
        ? '<div id="fnReactHolder"></div>'
        : path === "navigation/groups"
          ? {
              groups: [
                { ID: 102, name: "Youth", shortname: "youth" },
                { ID: 103, name: "YOUTH", shortname: "other" },
              ],
            }
          : { everyoneGroupID: 101 };
    await expect(
      network.findGroup({ read, check: () => {} }, "Youth"),
    ).rejects.toMatchObject({ code: "group_ambiguous" });
  });

  it("discovers groups without a hosting platform and resolves relationships from the cached network", async () => {
    const network = new Network("example-parish", { cacheMs: 60_000 });
    const responses: Record<string, unknown> = {
      dashboard: '<div id="fnReactHolder"></div>',
      "navigation/groups": {
        groups: [{ ID: 102, name: "Volunteers", shortname: "volunteers" }],
      },
      "network/getMetadata": { everyoneGroupID: 101 },
    };
    const read = vi.fn(async (path: string) => {
      if (!(path in responses)) throw new Error("Missing fictional fixture");
      return responses[path];
    });
    const context = { read, check: () => {} };
    expect(read).not.toHaveBeenCalled();
    expect(
      (await network.discoverGroups(context)).map((group) => group.id),
    ).toEqual(["101", "102"]);
    expect((await network.findGroup(context, " volunteers ")).id).toBe("102");
    expect(read.mock.calls.map(([path]) => path)).toEqual([
      "dashboard",
      "navigation/groups",
      "network/getMetadata",
    ]);
    network.clearGroups();
    await network.discoverGroups(context);
    expect(read).toHaveBeenCalledTimes(6);
  });
});
